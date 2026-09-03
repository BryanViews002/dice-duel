'use strict';
/**
 * Dice Duel - match server.
 *
 * Zero dependencies: node http + Server-Sent Events. State is in memory, which
 * is fine for a prototype and is the first thing you replace for production
 * (see README "What this prototype does not do").
 *
 * MONEY IS SIMULATED. Every account is credited with play chips on join. There
 * is no payment rail, no withdrawal, and no KYC here - deliberately.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const G = require('./game');

const PORT = Number(process.env.PORT || 8420);
const RAKE_BPS = Number(process.env.RAKE_BPS || G.DEFAULTS.rakeBps);
const ROLL_TIMEOUT_MS = Number(process.env.ROLL_TIMEOUT_MS || 20000);
const TIE_PAUSE_MS = Number(process.env.TIE_PAUSE_MS || 1500);
const STARTING_CHIPS = 10000; // cents

const players = new Map(); // playerId -> player
const matches = new Map(); // matchId  -> match
const queues = new Map();  // stakeCents -> [playerId]
const house = { rakeCollected: 0, matchesPlayed: 0 };

const id = () => crypto.randomBytes(12).toString('hex');
const money = (c) => (c / 100).toFixed(2);

// ---------------------------------------------------------------- events

function send(player, type, data) {
  if (!player || !player.sse) return;
  try {
    player.sse.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
  } catch (e) { /* client vanished; the SSE close handler cleans up */ }
}

function both(match, type, dataFor) {
  for (const side of ['a', 'b']) {
    const p = players.get(match[side].id);
    send(p, type, dataFor(side, p));
  }
}

/** Public view of a match from one side's perspective. Hides unrevealed dice. */
function view(match, side) {
  const me = match[side];
  const otherSide = side === 'a' ? 'b' : 'a';
  const them = match[otherSide];
  return {
    matchId: match.id,
    you: { name: players.get(me.id) && players.get(me.id).name, side, dice: me.dice, clientSeed: me.clientSeed },
    opponent: { name: players.get(them.id) && players.get(them.id).name, side: otherSide, dice: them.dice },
    stake: match.stake,
    pot: G.potMath(match.stake, RAKE_BPS),
    round: match.round,
    turn: match.turn,
    yourTurn: match.turn === side,
    status: match.status,
    serverSeedHash: match.serverSeedHash,
    history: match.history,
  };
}

// ---------------------------------------------------------------- matchmaking

function enqueue(player, stake, clientSeed) {
  player.clientSeed = clientSeed || crypto.randomBytes(8).toString('hex');
  const q = queues.get(stake) || [];

  // Pop the first still-valid opponent (skip anyone who disconnected or went broke).
  while (q.length) {
    const other = players.get(q.shift());
    if (!other || other.matchId || other.balance < stake || other.id === player.id) continue;
    queues.set(stake, q);
    startMatch(other, player, stake);
    return;
  }

  q.push(player.id);
  queues.set(stake, q);
  player.queuedStake = stake;
  send(player, 'queued', { stake, position: q.length });
}

function startMatch(pa, pb, stake) {
  // Escrow both stakes up front. Nobody can rage-quit with the pot.
  pa.balance -= stake;
  pb.balance -= stake;

  const serverSeed = G.newServerSeed();
  const match = {
    id: id(),
    stake,
    serverSeed,
    serverSeedHash: G.commit(serverSeed),
    a: { id: pa.id, clientSeed: pa.clientSeed, dice: null, secret: null },
    b: { id: pb.id, clientSeed: pb.clientSeed, dice: null, secret: null },
    round: 0,
    turn: 'a',
    status: 'playing',
    history: [],
    timer: null,
  };
  matches.set(match.id, match);
  pa.matchId = match.id;
  pb.matchId = match.id;
  pa.queuedStake = null;
  pb.queuedStake = null;

  both(match, 'matched', (side) => Object.assign(view(match, side), {
    balance: players.get(match[side].id).balance,
  }));
  nextRound(match);
}

// ---------------------------------------------------------------- round loop

function nextRound(match) {
  match.round += 1;
  if (match.round > G.DEFAULTS.maxRounds) { voidMatch(match, 'round limit reached'); return; }

  // Both rolls are derived from the committed seed NOW, before either player
  // acts. Revealing them one at a time is theatre - the outcome is already
  // fixed and provable, so turn order cannot matter.
  match.a.secret = G.rollDice(match.serverSeed, match.a.clientSeed, match.b.clientSeed, match.round, 'A');
  match.b.secret = G.rollDice(match.serverSeed, match.a.clientSeed, match.b.clientSeed, match.round, 'B');
  match.a.dice = null;
  match.b.dice = null;
  match.turn = 'a';
  match.status = 'playing';

  both(match, 'round', (side) => view(match, side));
  armTimer(match);
}

/** A player who stalls gets auto-rolled, so a match always terminates. */
function armTimer(match) {
  clearTimeout(match.timer);
  match.timer = setTimeout(() => {
    const m = matches.get(match.id);
    if (m && m.status === 'playing') doRoll(m, m[m.turn].id, true);
  }, ROLL_TIMEOUT_MS);
}

function doRoll(match, playerId, auto) {
  const side = match.a.id === playerId ? 'a' : match.b.id === playerId ? 'b' : null;
  if (!side) return { error: 'not in this match' };
  if (match.status !== 'playing') return { error: 'match is not accepting rolls' };
  if (match.turn !== side) return { error: 'not your turn' };

  clearTimeout(match.timer);
  match[side].dice = match[side].secret;
  both(match, 'rolled', (s) => Object.assign(view(match, s), { rolledBy: side, auto: !!auto }));

  if (side === 'a') {
    match.turn = 'b';
    both(match, 'turn', (s) => view(match, s));
    armTimer(match);
    return { ok: true };
  }

  // Both dice are now on the table. Lock the match immediately: until the next
  // round is dealt (or the match ends) no further roll is legal. Without this,
  // a client that keeps POSTing /api/roll during the tie pause would re-settle
  // the same round over and over, duplicating history and racing several
  // nextRound timers against each other.
  match.status = 'settling';

  const r = G.settleRound(match.a.dice, match.b.dice);
  match.history.push({
    round: match.round,
    diceA: match.a.dice,
    diceB: match.b.dice,
    scoreA: r.scoreA,
    scoreB: r.scoreB,
    result: r.result,
  });

  if (r.result === 'TIE') {
    both(match, 'tie', (s) => Object.assign(view(match, s), { scores: r }));
    // Held on match.timer so it is cancelled if the match goes away first.
    match.timer = setTimeout(() => { if (matches.has(match.id)) nextRound(match); }, TIE_PAUSE_MS);
  } else {
    finish(match, r.result === 'A' ? 'a' : 'b', r);
  }
  return { ok: true };
}

function finish(match, winnerSide, r) {
  const loserSide = winnerSide === 'a' ? 'b' : 'a';
  const pm = G.potMath(match.stake, RAKE_BPS);
  const winner = players.get(match[winnerSide].id);
  const loser = players.get(match[loserSide].id);
  if (winner) winner.balance += pm.payout;
  house.rakeCollected += pm.rake;
  house.matchesPlayed += 1;
  match.status = 'finished';

  const proof = {
    serverSeed: match.serverSeed,          // revealed only now
    serverSeedHash: match.serverSeedHash,
    clientSeedA: match.a.clientSeed,
    clientSeedB: match.b.clientSeed,
    rounds: match.history,
  };
  const verification = G.verifyMatch(proof);

  both(match, 'finished', (side) => {
    const p = players.get(match[side].id);
    return Object.assign(view(match, side), {
      winner: winnerSide,
      youWon: side === winnerSide,
      scores: r,
      pot: pm.pot,
      rake: pm.rake,
      payout: pm.payout,
      delta: side === winnerSide ? pm.payout - match.stake : -match.stake,
      balance: p && p.balance,
      proof,
      verification,
    });
  });

  if (winner) winner.matchId = null;
  if (loser) loser.matchId = null;
  clearTimeout(match.timer);
  matches.delete(match.id);
}

function voidMatch(match, reason) {
  for (const side of ['a', 'b']) {
    const p = players.get(match[side].id);
    if (p) { p.balance += match.stake; p.matchId = null; }   // refund escrow
  }
  match.status = 'void';
  both(match, 'void', (side) => {
    const p = players.get(match[side].id);
    return Object.assign(view(match, side), { reason, balance: p && p.balance });
  });
  clearTimeout(match.timer);
  matches.delete(match.id);
}

// ---------------------------------------------------------------- http api

const routes = {
  'POST /api/join': (body) => {
    const player = {
      id: id(),
      name: String(body.name || 'anon').slice(0, 24),
      balance: STARTING_CHIPS,
      sse: null,
      matchId: null,
      queuedStake: null,
      clientSeed: null,
    };
    players.set(player.id, player);
    return { playerId: player.id, name: player.name, balance: player.balance, rakeBps: RAKE_BPS };
  },

  'POST /api/queue': (body) => {
    const player = players.get(body.playerId);
    if (!player) return { error: 'unknown player' };
    if (player.matchId) return { error: 'already in a match' };
    const stake = Math.round(Number(body.stake) || 0);
    if (!Number.isInteger(stake) || stake <= 0) return { error: 'invalid stake' };
    if (stake > player.balance) return { error: 'insufficient balance (have ' + money(player.balance) + ')' };
    enqueue(player, stake, body.clientSeed);
    return { ok: true, stake };
  },

  'POST /api/roll': (body) => {
    const player = players.get(body.playerId);
    if (!player) return { error: 'unknown player' };
    const match = matches.get(player.matchId);
    if (!match) return { error: 'no active match' };
    return doRoll(match, player.id, false);
  },

  'POST /api/leave': (body) => {
    const player = players.get(body.playerId);
    if (!player) return { error: 'unknown player' };
    for (const entry of queues) queues.set(entry[0], entry[1].filter((x) => x !== player.id));
    player.queuedStake = null;
    return { ok: true };
  },

  'POST /api/verify': (body) => G.verifyMatch(body.proof),

  'GET /api/stats': () => ({
    players: players.size,
    activeMatches: matches.size,
    queued: [...queues].map((e) => ({ stake: e[0], waiting: e[1].length })).filter((x) => x.waiting),
    house: Object.assign({}, house, { rakeBps: RAKE_BPS }),
  }),
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);

  if (url.pathname === '/api/events') {
    const player = players.get(url.searchParams.get('playerId'));
    if (!player) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    player.sse = res;
    send(player, 'hello', { balance: player.balance, name: player.name });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      if (player.sse === res) player.sse = null;
      for (const entry of queues) queues.set(entry[0], entry[1].filter((x) => x !== player.id));
    });
    return;
  }

  const route = routes[req.method + ' ' + url.pathname];
  if (route) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = route(raw ? JSON.parse(raw) : {}); }
      catch (e) { out = { error: e.message }; }
      res.writeHead(out && out.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  // static files
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const root = path.join(__dirname, 'public');
  const file = path.join(root, path.normalize(rel).replace(/^[/\\]+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Dice Duel on http://localhost:' + PORT + '  (rake ' + RAKE_BPS / 100 + '%, play chips only)');
  });
}

module.exports = { server, players, matches, queues, house };
