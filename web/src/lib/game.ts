/**
 * Dice Duel - shared game logic and the independent fairness verifier.
 *
 * The dice construction here MUST stay byte-for-byte identical to
 * public.fair_dice() in supabase/migrations/0001_init.sql. That is the whole
 * point: the database rolls the dice, and this code re-rolls them in the
 * player's own browser to prove the database did not cheat.
 *
 *   dice = HMAC_SHA256(key = serverSeed, msg = "<seedA>:<seedB>:<round>:<role>:<counter>")
 *   bytes >= 252 are rejected (not folded) so every face is exactly 1/6
 */

export type Die = 1 | 2 | 3 | 4 | 5 | 6;
export type Dice = [Die, Die];
export type Seat = 'a' | 'b';
export type RoundResult = 'A' | 'B' | 'TIE';

const enc = new TextEncoder();

async function hmac(key: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fairDice(
  serverSeed: string,
  clientSeedA: string,
  clientSeedB: string,
  round: number,
  role: 'A' | 'B',
): Promise<Dice> {
  const dice: number[] = [];
  for (let counter = 0; dice.length < 2; counter++) {
    const digest = await hmac(serverSeed, `${clientSeedA}:${clientSeedB}:${round}:${role}:${counter}`);
    for (const byte of digest) {
      if (byte >= 252) continue; // rejection sample -> unbiased
      dice.push((byte % 6) + 1);
      if (dice.length === 2) break;
    }
  }
  return dice as Dice;
}

/** A player's score for a round: how many sixes are showing. */
export function countSixes(dice: readonly number[] | null | undefined): number {
  return (dice ?? []).filter((d) => d === 6).length;
}

/** Most sixes wins. Equal sixes is a tie, and the round is replayed. */
export function settleRound(diceA: readonly number[], diceB: readonly number[]): RoundResult {
  const a = countSixes(diceA);
  const b = countSixes(diceB);
  return a > b ? 'A' : b > a ? 'B' : 'TIE';
}

export function scoreLabel(dice: readonly number[] | null | undefined): string {
  if (!dice?.length) return '';
  const n = countSixes(dice);
  return n === 0 ? 'no sixes' : n === 1 ? 'one six' : 'double six';
}

/** Pot math in integer cents. Rake rounds down, so the player is never overcharged. */
export function potMath(stakeKobo: number, rakeBps: number) {
  const pot = stakeKobo * 2;
  const rake = Math.floor((pot * rakeBps) / 10000);
  return { pot, rake, payout: pot - rake, profit: pot - rake - stakeKobo };
}

// ---------------------------------------------------------------- verifier

export type ProofRound = {
  round_no: number;
  dice_a: number[] | null;
  dice_b: number[] | null;
  result: RoundResult | null;
};

export type Proof = {
  server_seed_hash: string;
  revealed_server_seed: string;
  client_seed_a: string;
  client_seed_b: string;
  rounds: ProofRound[];
};

export type VerifyStep = {
  round: number;
  expectedA: Dice;
  expectedB: Dice;
  actualA: number[] | null;
  actualB: number[] | null;
  diceMatch: boolean;
  resultMatch: boolean;
};

export type VerifyReport = {
  ok: boolean;
  commitmentOk: boolean;
  reason: string;
  steps: VerifyStep[];
};

/**
 * Recompute an entire match from its revealed seed.
 *
 * Two independent things are checked:
 *   1. sha256(revealed seed) equals the hash published before the match began,
 *      so the house could not have picked a seed after seeing the outcome.
 *   2. Every die reproduces from that seed, and every round was scored by the
 *      stated rules.
 */
export async function verifyProof(proof: Proof): Promise<VerifyReport> {
  const steps: VerifyStep[] = [];

  const commitmentOk = (await sha256Hex(proof.revealed_server_seed)) === proof.server_seed_hash;
  if (!commitmentOk) {
    return {
      ok: false,
      commitmentOk: false,
      reason: 'The revealed seed does not hash to the commitment published before the match. Do not trust this result.',
      steps,
    };
  }

  for (const r of proof.rounds) {
    const expectedA = await fairDice(proof.revealed_server_seed, proof.client_seed_a, proof.client_seed_b, r.round_no, 'A');
    const expectedB = await fairDice(proof.revealed_server_seed, proof.client_seed_a, proof.client_seed_b, r.round_no, 'B');

    const diceMatch =
      !!r.dice_a && !!r.dice_b &&
      expectedA.join() === r.dice_a.join() &&
      expectedB.join() === r.dice_b.join();

    const resultMatch = !!r.dice_a && !!r.dice_b && settleRound(r.dice_a, r.dice_b) === r.result;

    steps.push({ round: r.round_no, expectedA, expectedB, actualA: r.dice_a, actualB: r.dice_b, diceMatch, resultMatch });
  }

  const bad = steps.find((s) => !s.diceMatch || !s.resultMatch);
  return {
    ok: !bad,
    commitmentOk: true,
    reason: bad
      ? `Round ${bad.round} does not reproduce from the committed seed.`
      : steps.length === 1
        ? 'The single round reproduces exactly from the committed seed.'
        : `All ${steps.length} rounds reproduce from the committed seed.`,
    steps,
  };
}
