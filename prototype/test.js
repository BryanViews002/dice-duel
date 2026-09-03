'use strict';
/**
 * Tests for the Dice Duel rules engine.
 *
 * The important ones are not "does the code run" but "is the game actually
 * fair and is the money conserved" - the two things a player would sue over.
 */

const assert = require('assert');
const crypto = require('crypto');
const G = require('./game');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

console.log('\nRules');

test('one six beats no sixes', () => {
  assert.strictEqual(G.settleRound([6, 2], [3, 4]).result, 'A');
  assert.strictEqual(G.settleRound([1, 1], [5, 6]).result, 'B');
});

test('double six beats a single six', () => {
  assert.strictEqual(G.settleRound([6, 6], [6, 3]).result, 'A');
  assert.strictEqual(G.settleRound([6, 1], [6, 6]).result, 'B');
});

test('equal number of sixes is a tie -> replay', () => {
  assert.strictEqual(G.settleRound([6, 6], [6, 6]).result, 'TIE'); // both double six
  assert.strictEqual(G.settleRound([6, 2], [6, 5]).result, 'TIE'); // both single six
  assert.strictEqual(G.settleRound([1, 2], [3, 4]).result, 'TIE'); // neither has a six
});

test('the non-six faces are irrelevant', () => {
  // A 5-5 does NOT beat a 1-1. Only sixes are counted, per the stated rules.
  assert.strictEqual(G.settleRound([5, 5], [1, 1]).result, 'TIE');
});

console.log('\nOdds (exhaustive over all 36 x 36 = 1296 dice combinations)');

test('score distribution is 25/36 : 10/36 : 1/36', () => {
  const counts = [0, 0, 0];
  for (let d1 = 1; d1 <= 6; d1++) for (let d2 = 1; d2 <= 6; d2++) counts[G.sixes([d1, d2])]++;
  assert.deepStrictEqual(counts, [25, 10, 1]);
});

test('the game is exactly 50/50 and ties are 726/1296', () => {
  const tally = { A: 0, B: 0, TIE: 0 };
  for (let a1 = 1; a1 <= 6; a1++) for (let a2 = 1; a2 <= 6; a2++)
    for (let b1 = 1; b1 <= 6; b1++) for (let b2 = 1; b2 <= 6; b2++)
      tally[G.settleRound([a1, a2], [b1, b2]).result]++;

  assert.strictEqual(tally.A, 285);
  assert.strictEqual(tally.B, 285);      // perfectly symmetric: no first-mover edge
  assert.strictEqual(tally.TIE, 726);
  assert.strictEqual(tally.A + tally.B + tally.TIE, 1296);

  const tieRate = tally.TIE / 1296;
  console.log('        tie rate ' + (tieRate * 100).toFixed(2) + '%'
    + ', avg rounds per match ' + (1 / (1 - tieRate)).toFixed(2));
});

console.log('\nProvably fair RNG');

test('dice are deterministic given the seeds', () => {
  const a = G.rollDice('server-seed', 'alice', 'bob', 3, 'A');
  const b = G.rollDice('server-seed', 'alice', 'bob', 3, 'A');
  assert.deepStrictEqual(a, b);
});

test('players get different dice from the same round', () => {
  const a = G.rollDice('s', 'alice', 'bob', 1, 'A');
  const b = G.rollDice('s', 'alice', 'bob', 1, 'B');
  assert.ok(a.join() !== b.join() || true); // may coincide; the roles must differ in the HMAC
  assert.notStrictEqual(
    G.rollDice('s', 'x', 'y', 1, 'A').join() + '|' + G.rollDice('s', 'x', 'y', 1, 'B').join(),
    G.rollDice('s', 'x', 'y', 1, 'A').join() + '|' + G.rollDice('s', 'x', 'y', 1, 'A').join()
  );
});

test('each face lands within 1% of 1/6 over 600k dice', () => {
  const faces = [0, 0, 0, 0, 0, 0, 0];
  const seed = G.newServerSeed();
  for (let i = 0; i < 300000; i++) {
    for (const d of G.rollDice(seed, 'c1', 'c2', i, 'A')) faces[d]++;
  }
  const total = faces.reduce((s, x) => s + x, 0);
  for (let f = 1; f <= 6; f++) {
    const share = faces[f] / total;
    assert.ok(Math.abs(share - 1 / 6) < 0.01, 'face ' + f + ' share ' + share.toFixed(4));
  }
  console.log('        ' + total + ' dice, face shares '
    + faces.slice(1).map((c) => (c / total).toFixed(4)).join(' '));
});

test('commitment verifies and any tampering is caught', () => {
  const seed = G.newServerSeed();
  const rounds = [];
  for (let r = 1; r <= 3; r++) {
    const diceA = G.rollDice(seed, 'ca', 'cb', r, 'A');
    const diceB = G.rollDice(seed, 'ca', 'cb', r, 'B');
    const s = G.settleRound(diceA, diceB);
    rounds.push({ round: r, diceA, diceB, scoreA: s.scoreA, scoreB: s.scoreB, result: s.result });
  }
  const proof = { serverSeed: seed, serverSeedHash: G.commit(seed), clientSeedA: 'ca', clientSeedB: 'cb', rounds };
  assert.strictEqual(G.verifyMatch(proof).ok, true);

  // House swaps a losing roll for a winning one after the fact -> detected.
  const cheated = JSON.parse(JSON.stringify(proof));
  cheated.rounds[0].diceA = [6, 6];
  assert.strictEqual(G.verifyMatch(cheated).ok, false);

  // House reveals a different seed than it committed to -> detected.
  const swapped = Object.assign({}, proof, { serverSeed: G.newServerSeed() });
  assert.strictEqual(G.verifyMatch(swapped).ok, false);
});

console.log('\nMoney');

test('pot math is integer cents and conserves value', () => {
  const stake = 500;                       // $5.00 each
  const pm = G.potMath(stake, 250);        // 2.5% rake
  assert.strictEqual(pm.pot, 1000);
  assert.strictEqual(pm.rake, 25);
  assert.strictEqual(pm.payout, 975);
  assert.strictEqual(pm.profit, 475);
  assert.strictEqual(pm.payout + pm.rake, stake * 2); // nothing created or destroyed
});

test('rake rounds down, never up (never overcharge the player)', () => {
  for (let stake = 1; stake <= 2000; stake++) {
    const pm = G.potMath(stake, 250);
    assert.ok(Number.isInteger(pm.rake) && Number.isInteger(pm.payout));
    assert.ok(pm.rake <= (stake * 2 * 250) / 10000 + 1e-9);
    assert.strictEqual(pm.rake + pm.payout, stake * 2);
  }
});

test('zero rake means a pure zero-sum game between the two players', () => {
  const pm = G.potMath(1000, 0);
  assert.strictEqual(pm.profit, 1000);     // winner nets exactly what the loser lost
});

console.log('\nSimulated matches (Monte Carlo)');

test('100k full matches: win rate ~50%, house take matches the rake', () => {
  const N = 100000;
  const stake = 1000;      // $10 each
  const rakeBps = 250;
  let winsA = 0, rounds = 0, houseTake = 0, bankrollA = 0, bankrollB = 0;

  for (let m = 0; m < N; m++) {
    const seed = G.newServerSeed();
    let r = 0, res;
    do {
      r++; rounds++;
      res = G.settleRound(
        G.rollDice(seed, 'a', 'b', r, 'A'),
        G.rollDice(seed, 'a', 'b', r, 'B')
      ).result;
    } while (res === 'TIE');

    const pm = G.potMath(stake, rakeBps);
    houseTake += pm.rake;
    if (res === 'A') { winsA++; bankrollA += pm.profit; bankrollB -= stake; }
    else { bankrollB += pm.profit; bankrollA -= stake; }
  }

  const winRate = winsA / N;
  const avgRounds = rounds / N;
  console.log('        player A win rate ' + (winRate * 100).toFixed(2) + '%'
    + ' | avg rounds/match ' + avgRounds.toFixed(2)
    + ' | house take $' + (houseTake / 100).toFixed(2)
    + ' (' + ((houseTake / (N * stake * 2)) * 100).toFixed(2) + '% of wagered)');

  assert.ok(Math.abs(winRate - 0.5) < 0.01, 'win rate drifted: ' + winRate);
  assert.ok(Math.abs(avgRounds - 2.2727) < 0.05, 'avg rounds off: ' + avgRounds);
  // Every cent is accounted for: what the players lost, the house holds.
  assert.strictEqual(bankrollA + bankrollB + houseTake, 0);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (with failures)' : '') + '\n');
