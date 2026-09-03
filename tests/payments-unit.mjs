/**
 * Unit tests for the money boundary and the payout status mapping.
 *
 * These two things cause more real payment losses than anything else:
 *   - a unit conversion that pays 100x or 1/100th
 *   - a pending transfer read as failed, refunded, and then settled anyway
 *
 * Run: node --experimental-strip-types tests/payments-unit.mjs
 */

import { koboToNaira, nairaToKobo, terminalStatus } from '../web/src/lib/money.ts';

let pass = 0, fail = 0;
const ok = (cond, msg) => cond ? (pass++, console.log('  PASS  ' + msg))
                               : (fail++, console.log('  FAIL  ' + msg));

console.log('\nkobo <-> naira boundary\n');

ok(koboToNaira(250000) === 2500, '₦2,500.00 stored as 250000 kobo sends as 2500 naira');
ok(koboToNaira(100) === 1, '100 kobo sends as 1 naira');
ok(koboToNaira(1) === 0.01, '1 kobo sends as 0.01 naira');
ok(koboToNaira(123456) === 1234.56, '123456 kobo sends as 1234.56 naira');
ok(koboToNaira(0) === 0, 'zero survives the boundary');

// The whole reason the function is strict: a float here means a wrong payout.
let threw = false;
try { koboToNaira(1234.5); } catch { threw = true; }
ok(threw, 'a non-integer kobo amount is rejected rather than silently rounded');

ok(nairaToKobo(2500) === 250000, '2500 naira from Flutterwave reads back as 250000 kobo');
ok(nairaToKobo('1234.56') === 123456, 'a string amount "1234.56" reads back as 123456 kobo');
ok(nairaToKobo(0.01) === 1, '0.01 naira reads back as 1 kobo');

// Binary float: 1234.56 * 100 is 123455.99999999999. Math.trunc would lose a kobo.
ok(nairaToKobo(1234.56) === 123456, 'float error does not lose a kobo (trunc would give 123455)');
ok(nairaToKobo(19.99) === 1999, '19.99 does not become 1998');

// Round-tripping must be lossless across a wide range, or balances drift.
let drifted = 0;
for (let kobo = 1; kobo <= 200000; kobo += 7) {
  if (nairaToKobo(koboToNaira(kobo)) !== kobo) drifted++;
}
ok(drifted === 0, `kobo -> naira -> kobo is lossless across ~28,500 amounts (${drifted} drifted)`);

console.log('\nterminal status mapping — the refund guard\n');

ok(terminalStatus('SUCCESSFUL') === 'paid', 'SUCCESSFUL settles as paid');
ok(terminalStatus('successful') === 'paid', 'lower-case successful settles as paid');
ok(terminalStatus('FAILED') === 'failed', 'FAILED settles as failed');

// Every one of these must be null. A 'failed' here refunds a player whose
// transfer is still alive, and they end up with the money twice.
for (const pending of ['PENDING', 'NEW', 'PROCESSING', 'pending', '', null, undefined,
                       'SOMETHING_ELSE', 'QUEUED', 'ON_HOLD']) {
  ok(terminalStatus(pending) === null,
    `${JSON.stringify(pending)} is NOT terminal — never refunded on this`);
}

console.log('\nfee and net arithmetic\n');

// Mirrors request_withdrawal: fee is capped so net is always > 0.
const netOf = (amount, fee) => amount - Math.min(fee, amount - 1);
ok(netOf(100000, 5000) === 95000, '₦1,000 withdrawal less ₦50 fee lands ₦950');
ok(netOf(100, 5000) === 1, 'a fee larger than the amount cannot produce a zero or negative payout');
ok(netOf(5001, 5000) === 1, 'fee exactly one kobo under the amount still leaves 1 kobo');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
