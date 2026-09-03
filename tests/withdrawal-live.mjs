/**
 * Live tests for the withdrawal state machine, against your real Supabase.
 *
 * This exercises every way a payout system loses money. No Flutterwave calls
 * are made — settlement outcomes are driven directly, which is exactly how you
 * simulate the nasty cases (duplicate webhook, reversal after success, a
 * "failed" that arrives twice) without needing a bank to misbehave for you.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in web/.env.local, because the settlement
 * functions are deliberately revoked from `authenticated`. The key is read from
 * your own env file and never leaves this machine.
 *
 * Run AFTER applying 0006_naira.sql and 0007_payments.sql:
 *   node --experimental-strip-types tests/withdrawal-live.mjs
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const envText = fs.readFileSync(new URL('../web/.env.local', import.meta.url), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}
const URL_ = (env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE) {
  console.error('\nSUPABASE_SERVICE_ROLE_KEY is not in web/.env.local.');
  console.error('Settlement functions are revoked from `authenticated` by design,');
  console.error('so these tests need the service role to simulate webhooks.\n');
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log('  PASS  ' + m)) : (fail++, console.log('  FAIL  ' + m));
const naira = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

const api = async (path, { token, method = 'GET', body } = {}) => {
  const res = await fetch(URL_ + path, {
    method,
    headers: {
      apikey: ANON,
      Authorization: 'Bearer ' + (token ?? ANON),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: res.status, json, text };
};

const asUser    = (fn, token, args) => api('/rest/v1/rpc/' + fn, { token, method: 'POST', body: args });
const asService = (fn, args) => api('/rest/v1/rpc/' + fn, { token: SERVICE, method: 'POST', body: args });

const ref = (tag) => `test-${tag}-${crypto.randomBytes(6).toString('hex')}`;

async function signUp(tag) {
  const email = `wd-${tag}-${Date.now().toString(36)}@dicedueltest.com`;
  const r = await api('/auth/v1/signup', {
    method: 'POST',
    body: { email, password: 'DiceDuel!2026', data: { username: 'wd_' + tag + Date.now().toString(36).slice(-4) } },
  });
  if (!r.json?.access_token) throw new Error('signup failed: ' + r.text.slice(0, 200));
  return { token: r.json.access_token, id: r.json.user.id, email };
}

/** Credit a player directly, the way a confirmed deposit would. */
async function fund(playerId, kobo) {
  await asService('adjust_balance', {
    p_player: playerId, p_amount: kobo, p_kind: 'deposit', p_match: null,
  });
  // Deposits normally add a wagering requirement; clear it so these tests are
  // about the payout machinery, not the wagering rule (covered separately).
  await api(`/rest/v1/profiles?id=eq.${playerId}`, {
    token: SERVICE, method: 'PATCH', body: { wagering_required_kobo: 0 },
  });
}

const balanceOf = async (playerId) =>
  (await api(`/rest/v1/profiles?id=eq.${playerId}&select=balance_kobo`, { token: SERVICE }))
    .json?.[0]?.balance_kobo;

const withdrawalOf = async (reference) =>
  (await api(`/rest/v1/withdrawals?reference=eq.${reference}&select=*`, { token: SERVICE })).json?.[0];

async function addAccount(playerId) {
  const r = await api('/rest/v1/bank_accounts', {
    token: SERVICE, method: 'POST',
    body: {
      player_id: playerId, bank_code: '058', bank_name: 'Test Bank',
      account_number: '0690000031', account_name: 'TEST ACCOUNT',
    },
  });
  return r.json?.[0]?.id;
}

console.log('\nWithdrawal state machine (live)\n');
console.log('project:', URL_, '\n');

const START = 5_000_00;   // ₦5,000
const AMT   = 1_000_00;   // ₦1,000

// ---------------------------------------------------------------- 1. debit on request
{
  const u = await signUp('a');
  await fund(u.id, START);
  const acct = await addAccount(u.id);
  const r1 = ref('debit');

  const before = await balanceOf(u.id);
  const res = await asUser('request_withdrawal', u.token,
    { p_amount_kobo: AMT, p_bank_account_id: acct, p_reference: r1 });
  ok(res.status === 200, 'a valid withdrawal request is accepted');

  const after = await balanceOf(u.id);
  ok(after === before - AMT,
    `funds are debited at REQUEST time, not on success (${naira(before)} -> ${naira(after)})`);

  const w = await withdrawalOf(r1);
  ok(w?.status === 'requested', 'row opens in the non-terminal state "requested"');
  ok(w?.net_kobo === AMT - w?.fee_kobo, `net is amount less fee (${naira(w.net_kobo)} after ${naira(w.fee_kobo)} fee)`);

  // --- 2. a second request cannot exist ---------------------------------
  const second = await asUser('request_withdrawal', u.token,
    { p_amount_kobo: AMT, p_bank_account_id: acct, p_reference: ref('double') });
  ok(second.status >= 400 && /in progress/i.test(second.text),
    'a SECOND withdrawal while one is live is refused — the double-payout class is closed');
  ok(await balanceOf(u.id) === after, 'the refused request did not debit anything');

  // --- 3. non-terminal statuses must never settle ------------------------
  const bad = await asService('settle_withdrawal',
    { p_reference: r1, p_outcome: 'processing', p_flw_status: 'PENDING', p_reason: null });
  ok(bad.status >= 400, 'settle_withdrawal REFUSES a non-terminal outcome (this is the refund guard)');
  ok(await balanceOf(u.id) === after, 'the refused settlement moved no money');

  // --- 4. paid does not credit anything ---------------------------------
  const paid = await asService('settle_withdrawal',
    { p_reference: r1, p_outcome: 'paid', p_flw_status: 'SUCCESSFUL', p_reason: null });
  ok(paid.json === 'paid', 'a successful payout settles as paid');
  ok(await balanceOf(u.id) === after,
    'settling PAID credits nothing — the money already left at request time');

  // --- 5. duplicate webhook ---------------------------------------------
  const dupe = await asService('settle_withdrawal',
    { p_reference: r1, p_outcome: 'paid', p_flw_status: 'SUCCESSFUL', p_reason: null });
  ok(dupe.json === 'noop', 'a DUPLICATE "paid" webhook is a no-op');
  ok(await balanceOf(u.id) === after, 'the duplicate moved no money');

  // --- 6. reversal after success ----------------------------------------
  const rev = await asService('settle_withdrawal',
    { p_reference: r1, p_outcome: 'reversed', p_flw_status: 'REVERSED', p_reason: 'bank returned it' });
  ok(rev.json === 'refunded', 'a payout REVERSED by the bank after settling returns the funds');
  const afterReversal = await balanceOf(u.id);
  ok(afterReversal === before, `balance is whole again after reversal (${naira(afterReversal)})`);

  // --- 7. reversal cannot be applied twice ------------------------------
  await asService('settle_withdrawal',
    { p_reference: r1, p_outcome: 'reversed', p_flw_status: 'REVERSED', p_reason: 'again' });
  ok(await balanceOf(u.id) === afterReversal,
    'a repeated reversal does NOT refund twice (refunded_at guards it)');
}

// ---------------------------------------------------------------- failure path
{
  const u = await signUp('b');
  await fund(u.id, START);
  const acct = await addAccount(u.id);
  const r2 = ref('fail');

  const before = await balanceOf(u.id);
  await asUser('request_withdrawal', u.token,
    { p_amount_kobo: AMT, p_bank_account_id: acct, p_reference: r2 });
  ok(await balanceOf(u.id) === before - AMT, 'funds locked for the failing payout');

  const failed = await asService('settle_withdrawal',
    { p_reference: r2, p_outcome: 'failed', p_flw_status: 'FAILED', p_reason: 'bank declined' });
  ok(failed.json === 'refunded', 'a FAILED payout refunds');
  ok(await balanceOf(u.id) === before, `balance restored in full (${naira(before)})`);

  const again = await asService('settle_withdrawal',
    { p_reference: r2, p_outcome: 'failed', p_flw_status: 'FAILED', p_reason: 'duplicate delivery' });
  ok(again.json === 'already_refunded' || again.json === 'noop',
    'a duplicate FAILED webhook reports already-handled');
  ok(await balanceOf(u.id) === before,
    'the duplicate failure did NOT refund a second time — no free money');

  // A withdrawal can be opened again now that the last one is terminal.
  const next = await asUser('request_withdrawal', u.token,
    { p_amount_kobo: AMT, p_bank_account_id: acct, p_reference: ref('after-fail') });
  ok(next.status === 200, 'once terminal, the player may withdraw again');
}

// ---------------------------------------------------------------- guards
{
  const u = await signUp('c');
  await fund(u.id, START);
  const acct = await addAccount(u.id);

  const over = await asUser('request_withdrawal', u.token,
    { p_amount_kobo: START * 10, p_bank_account_id: acct, p_reference: ref('over') });
  ok(over.status >= 400, 'cannot withdraw more than the balance');

  const tiny = await asUser('request_withdrawal', u.token,
    { p_amount_kobo: 100, p_bank_account_id: acct, p_reference: ref('tiny') });
  ok(tiny.status >= 400 && /minimum/i.test(tiny.text), 'below-minimum withdrawals are refused');

  // Somebody else's payout account.
  const other = await signUp('d');
  const otherAcct = await addAccount(other.id);
  const theft = await asUser('request_withdrawal', u.token,
    { p_amount_kobo: AMT, p_bank_account_id: otherAcct, p_reference: ref('theft') });
  ok(theft.status >= 400 && /not yours/i.test(theft.text),
    "cannot pay out to somebody else's bank account");

  // The single most important privilege check in the payments system.
  const escalate = await asUser('settle_withdrawal', u.token,
    { p_reference: 'anything', p_outcome: 'failed', p_flw_status: 'x', p_reason: 'x' });
  ok(escalate.status >= 400,
    'a PLAYER cannot call settle_withdrawal — otherwise they could mark their own paid payout failed and be refunded');

  const credit = await asUser('credit_deposit', u.token,
    { p_reference: 'x', p_flw_tx_id: 1, p_verified_amount_kobo: 100000000, p_flw_status: 'successful' });
  ok(credit.status >= 400, 'a PLAYER cannot call credit_deposit — otherwise they could mint balance');

  // Regression guard for the worst bug this project has had: PostgreSQL grants
  // EXECUTE to PUBLIC by default, so `revoke ... from anon, authenticated`
  // removed nothing and adjust_balance was callable by any signed-in player.
  // A live account went from 0 to 99,999,999 kobo with one HTTP request.
  const before = await balanceOf(u.id);
  const mint = await asUser('adjust_balance', u.token,
    { p_player: u.id, p_amount: 99_999_999, p_kind: 'deposit', p_match: null });
  ok(mint.status >= 400,
    'a PLAYER cannot call adjust_balance — this one let anyone mint unlimited money');
  ok(await balanceOf(u.id) === before,
    'the mint attempt moved nothing (balance unchanged)');

  const peek = await asUser('stale_withdrawals', u.token, {});
  ok(peek.status >= 400,
    "a PLAYER cannot call stale_withdrawals — it would expose every player's pending payouts");

  const other2 = await signUp('f');
  const snoop = await asUser('withdrawable_kobo', u.token, { p_player: other2.id });
  ok(snoop.status >= 400,
    "a PLAYER cannot read somebody else's withdrawable balance");
}

// ---------------------------------------------------------------- wagering
{
  const u = await signUp('e');
  await asService('adjust_balance', { p_player: u.id, p_amount: START, p_kind: 'deposit', p_match: null });
  await api(`/rest/v1/profiles?id=eq.${u.id}`, {
    token: SERVICE, method: 'PATCH', body: { wagering_required_kobo: START },
  });
  const acct = await addAccount(u.id);

  const blocked = await asUser('request_withdrawal', u.token,
    { p_amount_kobo: AMT, p_bank_account_id: acct, p_reference: ref('wager') });
  ok(blocked.status >= 400 && /stake/i.test(blocked.text),
    'un-staked deposits cannot be withdrawn straight back out (deposit-and-run / laundering guard)');

  const avail = await asUser('withdrawable_kobo', u.token, { p_player: u.id });
  ok(Number(avail.json) === 0, 'withdrawable is 0 while the full wagering requirement stands');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
