'use strict';
/**
 * Dice Duel - pure rules engine.
 *
 * Rules (as specified):
 *   - Each player rolls TWO dice per round.
 *   - A player's score for the round is the NUMBER OF SIXES they rolled (0, 1, or 2).
 *   - Higher count wins the pot.
 *       * one six beats zero sixes
 *       * double six beats a single six
 *   - Equal count is a TIE -> the round is replayed (stakes stay escrowed, nothing
 *     is paid out, a new round is rolled).
 *
 * Consequences of the above (see test.js for the proofs):
 *   P(0 sixes) = 25/36, P(1 six) = 10/36, P(2 sixes) = 1/36
 *   P(tie in a round)  = 726/1296 ~= 55.98%   -> avg ~2.27 rounds per match
 *   P(each player wins the match) = exactly 50%  -> the game itself is fair;
 *   the only house edge is the configured rake.
 */

const crypto = require('crypto');

const DEFAULTS = {
  rakeBps: 250,      // house cut in basis points (250 = 2.5% of the pot)
  maxRounds: 64,     // safety valve; P(64 straight ties) ~ 1e-16 -> void & refund
};

/**
 * Provably fair dice.
 *
 * The server commits to `serverSeed` by publishing sha256(serverSeed) BEFORE any
 * money is at risk, both players contribute a `clientSeed`, and the seed is
 * revealed when the match ends. Anyone can then recompute every roll and confirm
 * the house did not pick outcomes after the fact.
 *
 * Uniformity: bytes >= 252 are rejected rather than folded, so each face is
 * exactly 1/6 (252 = 6 * 42). Naive `byte % 6` would bias 1-4 upward.
 */
function rollDice(serverSeed, clientSeedA, clientSeedB, round, role) {
  const dice = [];
  for (let counter = 0; dice.length < 2; counter++) {
    const msg = `${clientSeedA}:${clientSeedB}:${round}:${role}:${counter}`;
    const digest = crypto.createHmac('sha256', serverSeed).update(msg).digest();
    for (const byte of digest) {
      if (byte >= 252) continue;            // rejection sample -> unbiased
      dice.push((byte % 6) + 1);
      if (dice.length === 2) break;
    }
  }
  return dice;
}

function commit(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

function newServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/** A player's round score: how many sixes are showing. */
function sixes(dice) {
  return dice.filter((d) => d === 6).length;
}

/** Compare two rolls. Returns 'A' | 'B' | 'TIE'. */
function settleRound(diceA, diceB) {
  const a = sixes(diceA);
  const b = sixes(diceB);
  return { scoreA: a, scoreB: b, result: a > b ? 'A' : b > a ? 'B' : 'TIE' };
}

/**
 * Pot math, in integer minor units (cents). Never use floats for money.
 * Each player posts `stake`; the winner takes the pot less the rake.
 */
function potMath(stake, rakeBps = DEFAULTS.rakeBps) {
  const pot = stake * 2;
  const rake = Math.floor((pot * rakeBps) / 10000);
  return { pot, rake, payout: pot - rake, profit: pot - rake - stake };
}

/** Verify a finished match end-to-end from its published proof. */
function verifyMatch(proof) {
  const { serverSeed, serverSeedHash, clientSeedA, clientSeedB, rounds } = proof;
  if (commit(serverSeed) !== serverSeedHash) {
    return { ok: false, reason: 'server seed does not match the published commitment' };
  }
  for (const r of rounds) {
    const a = rollDice(serverSeed, clientSeedA, clientSeedB, r.round, 'A');
    const b = rollDice(serverSeed, clientSeedA, clientSeedB, r.round, 'B');
    if (a.join() !== r.diceA.join() || b.join() !== r.diceB.join()) {
      return { ok: false, reason: `round ${r.round} dice do not reproduce` };
    }
    if (settleRound(a, b).result !== r.result) {
      return { ok: false, reason: `round ${r.round} result was scored wrong` };
    }
  }
  return { ok: true, reason: `all ${rounds.length} round(s) reproduce from the committed seed` };
}

module.exports = {
  DEFAULTS, rollDice, commit, newServerSeed, sixes, settleRound, potMath, verifyMatch,
};
