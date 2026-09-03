'use strict';
/**
 * End-to-end test: boots the real server, drives two players over HTTP + SSE
 * through a complete match, and checks the ledger balances afterwards.
 */

const http = require('http');
const { server } = require('./server');

const PORT = 8499;
const base = 'http://127.0.0.1:' + PORT;

function post(path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());
}

/** Minimal SSE client: calls onEvent(type, data) for each message. */
function listen(playerId, onEvent) {
  return new Promise((resolve) => {
    const req = http.get(base + '/api/events?playerId=' + playerId, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(frame);
          const data = /^data: (.+)$/m.exec(frame);
          if (type && data) onEvent(type[1], JSON.parse(data[1]));
        }
      });
      resolve(req);
    });
  });
}

const fail = (msg) => { console.log('  FAIL  ' + msg); process.exitCode = 1; };
const pass = (msg) => console.log('  PASS  ' + msg);

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  console.log('\nEnd-to-end match over HTTP\n');

  const alice = await post('/api/join', { name: 'Alice' });
  const bob = await post('/api/join', { name: 'Bob' });
  const START = alice.balance;
  const STAKE = 1000;

  const seen = { alice: [], bob: [] };
  let done;
  const finished = new Promise((r) => { done = r; });
  const results = {};

  // Deliberately abusive client: on every event it fires a burst of rolls
  // rather than one. This is the regression guard for the bug where a client
  // could re-settle the same round during the tie pause, duplicating history
  // and racing several nextRound timers.
  const SPAM = 8;
  const handler = (who) => (type, data) => {
    seen[who].push(type);
    const pid = who === 'alice' ? alice.playerId : bob.playerId;
    if (data.yourTurn && ['round', 'turn', 'matched', 'rolled', 'tie'].includes(type)) {
      for (let i = 0; i < SPAM; i++) post('/api/roll', { playerId: pid });
    }
    if (type === 'tie') {
      // Keep hammering through the whole pause between rounds.
      for (let i = 0; i < SPAM; i++) post('/api/roll', { playerId: pid });
    }
    if (type === 'finished') {
      results[who] = data;
      if (results.alice && results.bob) done();
    }
  };

  await listen(alice.playerId, handler('alice'));
  await listen(bob.playerId, handler('bob'));

  await post('/api/queue', { playerId: alice.playerId, stake: STAKE, clientSeed: 'alice-seed' });
  const q = await post('/api/queue', { playerId: bob.playerId, stake: STAKE, clientSeed: 'bob-seed' });
  if (q.error) fail('queue rejected: ' + q.error);

  const timeout = setTimeout(() => { fail('match did not finish in 15s'); process.exit(1); }, 15000);
  await finished;
  clearTimeout(timeout);

  const a = results.alice;
  const b = results.bob;

  // --- assertions ---------------------------------------------------------
  if (a.matchId === b.matchId) pass('both players were placed in the same match');
  else fail('players landed in different matches');

  if (a.youWon !== b.youWon) pass('exactly one winner (' + (a.youWon ? 'Alice' : 'Bob') + ')');
  else fail('both players reported the same outcome');

  const last = a.history[a.history.length - 1];
  const winnerHadMoreSixes = last.result === 'A' ? last.scoreA > last.scoreB : last.scoreB > last.scoreA;
  if (winnerHadMoreSixes) pass('the winner is the player with more sixes: '
    + 'A ' + last.diceA.join('/') + ' (' + last.scoreA + ') vs B ' + last.diceB.join('/') + ' (' + last.scoreB + ')');
  else fail('winner did not have more sixes');

  // Regression: rounds must be numbered 1..N with no duplicates, even though
  // both clients spammed /api/roll throughout the match.
  const nums = a.history.map((h) => h.round);
  const sequential = nums.every((n, i) => n === i + 1);
  if (sequential) pass('history is exactly one entry per round, 1..' + nums.length
    + ' (roll spam did not duplicate any round)');
  else fail('history round numbers are not sequential: ' + nums.join(','));

  const ties = a.history.filter((h) => h.result === 'TIE').length;
  const allTiesReplayed = a.history.every((h, i) => (h.result === 'TIE') === (i < a.history.length - 1));
  if (allTiesReplayed) pass('every tie was replayed; the match ended on a decisive round ('
    + a.history.length + ' round(s), ' + ties + ' tie(s))');
  else fail('a tie ended the match, or play continued after a decision');

  const winner = a.youWon ? a : b;
  const loser = a.youWon ? b : a;
  if (winner.balance === START - STAKE + winner.payout) pass('winner credited: '
    + (START / 100) + ' - ' + (STAKE / 100) + ' + ' + (winner.payout / 100) + ' = ' + (winner.balance / 100));
  else fail('winner balance wrong: ' + winner.balance);

  if (loser.balance === START - STAKE) pass('loser debited exactly the stake: ' + (loser.balance / 100));
  else fail('loser balance wrong: ' + loser.balance);

  const stats = await fetch(base + '/api/stats').then((r) => r.json());
  const totalOut = winner.balance + loser.balance + stats.house.rakeCollected;
  if (totalOut === START * 2) pass('no chips created or destroyed (house holds ' + (stats.house.rakeCollected / 100) + ' rake)');
  else fail('ledger does not balance: ' + totalOut + ' vs ' + START * 2);

  if (a.verification.ok && b.verification.ok) pass('both players can verify the match: ' + a.verification.reason);
  else fail('fairness proof did not verify');

  if (stats.activeMatches === 0) pass('match cleaned up from server state');
  else fail('match left dangling');

  const tampered = JSON.parse(JSON.stringify(a.proof));
  tampered.rounds[tampered.rounds.length - 1].diceA = [6, 6];
  const v = await post('/api/verify', { proof: tampered });
  if (!v.ok) pass('server rejects a tampered proof: ' + v.reason);
  else fail('tampered proof was accepted');

  console.log('');
  server.close();
  process.exit(process.exitCode || 0);
})();
