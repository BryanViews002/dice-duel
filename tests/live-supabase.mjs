/**
 * Live end-to-end test against the real Supabase project.
 *
 * This is the test that actually matters: it exercises the Postgres game
 * engine, the RLS policies and the money ledger as a hostile-ish client, using
 * nothing but the public anon key and two ordinary user sessions.
 *
 * Run (after 0006_naira.sql and 0007_payments.sql):
 *   node --experimental-strip-types tests/live-supabase.mjs
 */

import fs from 'node:fs';
import { fairDice, countSixes } from '../web/src/lib/game.ts';

const envText = fs.readFileSync(new URL('../web/.env.local', import.meta.url), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '');
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE) {
  console.error('');
  console.error('SUPABASE_SERVICE_ROLE_KEY is required in web/.env.local.');
  console.error('Real-money accounts open empty, so test players must be funded');
  console.error('the way a settled deposit would fund them.');
  console.error('');
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (cond, msg) => cond ? (pass++, console.log('  PASS  ' + msg))
                               : (fail++, console.log('  FAIL  ' + msg));
const money = (k) => 'NGN ' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

const api = async (path, { token, method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(URL_ + path, {
    method,
    headers: {
      apikey: ANON,
      Authorization: 'Bearer ' + (token ?? ANON),
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
};

const rpc = (fn, token, args) =>
  api('/rest/v1/rpc/' + fn, { token, method: 'POST', body: args ?? {} });

async function signIn(email, password, username) {
  let r = await api('/auth/v1/signup', {
    method: 'POST',
    body: { email, password, data: { username } },
  });
  if (!r.json?.access_token) {
    r = await api('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email, password },
    });
  }
  if (!r.json?.access_token) throw new Error('could not get a session: ' + r.text.slice(0, 200));
  return { token: r.json.access_token, id: r.json.user.id, email };
}

const me = async (p) => (await api('/rest/v1/profiles?select=*', { token: p.token })).json?.[0];
const getMatch = async (p, id) => (await api(`/rest/v1/matches?id=eq.${id}&select=*`, { token: p.token })).json?.[0];
const getRounds = async (p, id) =>
  (await api(`/rest/v1/match_rounds?match_id=eq.${id}&select=*&order=round_no`, { token: p.token })).json ?? [];

console.log('\nLive Supabase end-to-end\n');
console.log('project:', URL_, '\n');

const STAMP = Date.now().toString(36);
const A = await signIn(`duel-a-${STAMP}@dicedueltest.com`, 'DiceDuel!2026', 'duel_a_' + STAMP);
const B = await signIn(`duel-b-${STAMP}@dicedueltest.com`, 'DiceDuel!2026', 'duel_b_' + STAMP);

// ---------------------------------------------------------------- profiles
const pa = await me(A), pb = await me(B);
ok(!!pa && !!pb, `handle_new_user() created both profiles (${pa?.username}, ${pb?.username})`);
ok(pa.balance_kobo === 0, 'a new account opens with a ZERO balance (no real-money signup gift)');

// Real money: fund both players the way a settled deposit would, so the match
// tests below still have something to stake.
const START = 500000; // NGN 5,000
for (const p of [A, B]) {
  await api('/rest/v1/rpc/adjust_balance', { token: SERVICE, method: 'POST',
    body: { p_player: p.id, p_amount: START, p_kind: 'deposit', p_match: null } });
  await api(`/rest/v1/profiles?id=eq.${p.id}`, { token: SERVICE, method: 'PATCH',
    body: { wagering_required_kobo: 0 } });
}
ok((await me(A)).balance_kobo === START, `funded both players with ${money(START)}`);

// ---------------------------------------------------------------- RLS: bankroll privacy
const spy = await api(`/rest/v1/profiles?select=*&id=eq.${B.id}`, { token: A.token });
ok(Array.isArray(spy.json) && spy.json.length === 0,
  "player A cannot read player B's profile row (bankroll stays private)");

const pub = await api(`/rest/v1/public_profiles?select=username&id=eq.${B.id}`, { token: A.token });
ok(pub.json?.[0]?.username === pb.username,
  'but A can see B\'s username via public_profiles (no money columns)');

// ---------------------------------------------------------------- RLS: direct writes
const cheat = await api(`/rest/v1/profiles?id=eq.${A.id}`, {
  token: A.token, method: 'PATCH', body: { balance_kobo: 999999 },
  headers: { Prefer: 'return=representation' },
});
const afterCheat = await me(A);
ok(afterCheat.balance_kobo === START,
  `direct balance write refused (status ${cheat.status}, balance still ${money(afterCheat.balance_kobo)})`);

// ---------------------------------------------------------------- matchmaking
const STAKE = 100000;   // NGN 1,000
const q1 = await rpc('join_queue', A.token, { p_stake: STAKE, p_client_seed: 'alice-seed' });
ok(q1.status === 200 && q1.json === null, 'first player queues and waits (no match yet)');

const q2 = await rpc('join_queue', B.token, { p_stake: STAKE, p_client_seed: 'bob-seed' });
const matchId = q2.json;
ok(typeof matchId === 'string' && matchId.length === 36, 'second player is matched instantly: ' + matchId);

let m = await getMatch(A, matchId);
ok(m.status === 'playing' && m.round === 1, 'match starts at round 1 in status "playing"');

const escrowA = await me(A), escrowB = await me(B);
ok(escrowA.balance_kobo === START - STAKE && escrowB.balance_kobo === START - STAKE,
  `both stakes escrowed up front (${money(escrowA.balance_kobo)} each)`);

// ---------------------------------------------------------------- THE seed test
const sealed = await api('/rest/v1/match_secrets?select=*', { token: A.token });
ok(sealed.status === 401 || sealed.status === 403,
  `a player in a LIVE match cannot read match_secrets (status ${sealed.status}, code ${sealed.json?.code ?? '-'})`);
ok(m.revealed_server_seed === null,
  'matches.revealed_server_seed is still null while the match is in progress');
ok(typeof m.server_seed_hash === 'string' && m.server_seed_hash.length === 64,
  'the seed commitment was published up front: ' + m.server_seed_hash.slice(0, 24) + '…');

// ---------------------------------------------------------------- turn order
const outOfTurn = await rpc('roll', B.token, { p_match_id: matchId });
ok(outOfTurn.status >= 400 && /not your turn/i.test(outOfTurn.text),
  'player B cannot roll on player A\'s turn');

// ---------------------------------------------------------------- play it out
let rounds = 0, ties = 0;
while (true) {
  m = await getMatch(A, matchId);
  if (m.status !== 'playing') break;
  if (++rounds > 70) { ok(false, 'match did not terminate'); break; }

  const rollA = await rpc('roll', A.token, { p_match_id: matchId });
  if (rollA.status >= 400) { ok(false, 'A roll failed: ' + rollA.text.slice(0, 120)); break; }

  // A must not be able to roll twice in the same round.
  if (rounds === 1) {
    const dbl = await rpc('roll', A.token, { p_match_id: matchId });
    ok(dbl.status >= 400, 'player A cannot roll twice in one round (' + (dbl.json?.message ?? dbl.status) + ')');
  }

  const rollB = await rpc('roll', B.token, { p_match_id: matchId });
  if (rollB.status >= 400) { ok(false, 'B roll failed: ' + rollB.text.slice(0, 120)); break; }

  // Count the round we just played, NOT rs[rs.length - 1]: on a tie the server
  // immediately deals the next round, so the last row is a fresh empty one with
  // result === null. Reading that undercounted every tie as zero.
  const rs = await getRounds(A, matchId);
  const played = rs.find((r) => r.round_no === m.round);
  if (played?.result === 'TIE') ties++;
}

m = await getMatch(A, matchId);
const finalRounds = await getRounds(A, matchId);
const tieRounds = finalRounds.filter((r) => r.result === 'TIE');
ok(m.status === 'finished',
  `match finished after ${finalRounds.length} round(s), ${tieRounds.length} tie(s)`);

const decider = finalRounds.filter((r) => r.result && r.result !== 'TIE');
ok(decider.length === 1, 'there is exactly one decisive round');
const d = decider[0];
ok(d && (d.result === 'A' ? d.score_a > d.score_b : d.score_b > d.score_a),
  `the winner had more sixes: A ${d?.dice_a?.join('/')} (${d?.score_a}) vs B ${d?.dice_b?.join('/')} (${d?.score_b})`);
ok(tieRounds.length === ties, `the tie counter agrees with the stored rounds (${ties})`);
ok(finalRounds.slice(0, -1).every((r) => r.result === 'TIE') &&
   finalRounds[finalRounds.length - 1].result !== 'TIE',
  'every tied round was replayed; only the last round decided it');

// ---------------------------------------------------------------- money
const finalA = await me(A), finalB = await me(B);
const winner = m.winner === 'a' ? finalA : finalB;
const loser  = m.winner === 'a' ? finalB : finalA;
ok(winner.balance_kobo === START - STAKE + m.payout_kobo,
  `winner paid out: ${money(START)} - ${money(STAKE)} + ${money(m.payout_kobo)} = ${money(winner.balance_kobo)}`);
ok(loser.balance_kobo === START - STAKE, `loser is down exactly the stake: ${money(loser.balance_kobo)}`);
ok(m.pot_kobo === STAKE * 2 && m.rake_kobo + m.payout_kobo === m.pot_kobo,
  `pot conserved: ${money(m.pot_kobo)} = ${money(m.payout_kobo)} payout + ${money(m.rake_kobo)} rake`);
ok(winner.balance_kobo + loser.balance_kobo + m.rake_kobo === START * 2,
  'no chips created or destroyed across the whole match');

const ledger = (await api(`/rest/v1/ledger?select=*&match_id=eq.${matchId}&order=id`, { token: A.token })).json ?? [];
ok(ledger.length >= 1 && ledger.every((e) => e.player_id === A.id),
  `ledger is append-only and A only sees their own ${ledger.length} entr${ledger.length === 1 ? 'y' : 'ies'}`);

// ---------------------------------------------------------------- THE fairness test
ok(typeof m.revealed_server_seed === 'string' && m.revealed_server_seed.length === 64,
  'the server seed is revealed once the match is over');

const { createHash } = await import('node:crypto');
const rehash = createHash('sha256').update(m.revealed_server_seed).digest('hex');
ok(rehash === m.server_seed_hash,
  'sha256(revealed seed) matches the commitment published before the first roll');

let diceMatch = 0, diceTotal = 0;
const mismatches = [];
for (const r of finalRounds) {
  if (!r.dice_a || !r.dice_b) continue;
  const expA = await fairDice(m.revealed_server_seed, m.client_seed_a, m.client_seed_b, r.round_no, 'A');
  const expB = await fairDice(m.revealed_server_seed, m.client_seed_a, m.client_seed_b, r.round_no, 'B');
  diceTotal += 2;
  if (expA.join() === r.dice_a.join()) diceMatch++; else mismatches.push({ round: r.round_no, seat: 'A', expected: expA, actual: r.dice_a });
  if (expB.join() === r.dice_b.join()) diceMatch++; else mismatches.push({ round: r.round_no, seat: 'B', expected: expB, actual: r.dice_b });
}
ok(diceTotal > 0 && diceMatch === diceTotal,
  `POSTGRES DICE == BROWSER VERIFIER for all ${diceTotal} rolls${mismatches.length ? ' — mismatches: ' + JSON.stringify(mismatches) : ''}`);

for (const r of finalRounds) {
  if (!r.dice_a || !r.dice_b) continue;
  const a = countSixes(r.dice_a), b = countSixes(r.dice_b);
  const expect = a > b ? 'A' : b > a ? 'B' : 'TIE';
  if (expect !== r.result) { ok(false, `round ${r.round_no} scored ${r.result}, rules say ${expect}`); break; }
}
ok(true, 'every round was scored by the stated rules (most sixes wins, equal sixes ties)');

// ---------------------------------------------------------------- public visibility
const stranger = await api(`/rest/v1/matches?id=eq.${matchId}&select=id,winner`, {});
ok(stranger.json?.[0]?.id === matchId,
  'a finished match is publicly readable, so anyone can verify it');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
