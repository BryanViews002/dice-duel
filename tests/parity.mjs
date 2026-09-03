/**
 * Parity test: the TypeScript verifier that runs in the player's browser must
 * produce exactly the same dice as the reference engine that was tested in
 * prototype/test.js. If these ever diverge, "provably fair" is a lie.
 */
import { rollDice as refRollDice } from '../prototype/game.js';
import { fairDice, countSixes, settleRound, potMath } from '../web/src/lib/game.ts';

let pass = 0, fail = 0;
const check = (ok, msg) => ok ? (pass++, console.log('  PASS  ' + msg))
                              : (fail++, console.log('  FAIL  ' + msg));

console.log('\nBrowser verifier vs reference engine\n');

let mismatches = 0;
const samples = [];
for (let i = 0; i < 400; i++) {
  const seed = 'seed-' + i.toString(16).padStart(4, '0');
  const round = (i % 17) + 1;
  const role = i % 2 ? 'B' : 'A';
  const a = await fairDice(seed, 'alice', 'bob', round, role);
  const b = refRollDice(seed, 'alice', 'bob', round, role);
  if (a.join() !== b.join()) { mismatches++; if (samples.length < 3) samples.push({ seed, round, role, a, b }); }
}
check(mismatches === 0, `400 seed/round/seat combinations produce identical dice${
  mismatches ? ' — ' + mismatches + ' mismatches: ' + JSON.stringify(samples) : ''}`);

// Distribution sanity on the TS path specifically.
const faces = new Array(7).fill(0);
for (let i = 0; i < 20000; i++) {
  for (const d of await fairDice('dist-seed', 'c1', 'c2', i, 'A')) faces[d]++;
}
const total = faces.reduce((a, b) => a + b, 0);
const shares = faces.slice(1).map((c) => c / total);
check(shares.every((s) => Math.abs(s - 1 / 6) < 0.012),
  'each face within 1.2% of 1/6 over ' + total + ' dice [' + shares.map((s) => s.toFixed(4)).join(' ') + ']');

// Rules
check(settleRound([6, 2], [3, 4]) === 'A', 'one six beats no sixes');
check(settleRound([6, 6], [6, 3]) === 'A', 'double six beats a single six');
check(settleRound([6, 1], [6, 5]) === 'TIE', 'equal sixes ties');
check(settleRound([1, 2], [3, 4]) === 'TIE', 'no sixes either side ties');
check(countSixes([6, 6]) === 2 && countSixes([5, 5]) === 0, 'sixes are counted, other faces ignored');

const pm = potMath(500, 250);
check(pm.pot === 1000 && pm.rake === 25 && pm.payout === 975, 'pot math matches the SQL rake formula');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
