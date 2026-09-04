/**
 * Dice Duel payout worker.
 *
 * Runs on a host with a FIXED IP (Railway / Fly / a small VPS) — that address is
 * what you whitelist with Flutterwave. It is the only component that talks to
 * the Transfers API, so it is the only egress IP that ever needs whitelisting.
 *
 * Two jobs, on one loop:
 *
 *   SEND       claim 'requested' withdrawals and initiate the transfer
 *   RECONCILE  chase anything left in 'processing' and settle it for real
 *
 * The rule that keeps money safe is the same one as everywhere else in this
 * codebase: NOTHING IS SETTLED UNLESS FLUTTERWAVE SAYS IT IS TERMINAL. A
 * timeout, a 502, an unrecognised status, or an unreachable API all leave the
 * row alone for the next pass. The only outcomes that move money are
 * SUCCESSFUL and FAILED, and refunds are guarded a second time in SQL by
 * refunded_at.
 *
 * Safe to run more than one instance: claim_withdrawals uses FOR UPDATE SKIP
 * LOCKED, and `reference` is Flutterwave's idempotency key behind that.
 *
 * Run:  node worker/index.mjs
 */

import { terminalStatus, koboToNaira } from '../web/src/lib/money.ts';

// ---------------------------------------------------------------- config

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`[fatal] ${k} is not set`);
    process.exit(1);
  }
  return v;
};

const SUPABASE_URL = need('NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
const SERVICE_KEY = need('SUPABASE_SERVICE_ROLE_KEY');
const FLW_KEY = need('FLW_SECRET_KEY');
const FLW_BASE = process.env.FLW_BASE_URL || 'https://api.flutterwave.com/v3';
const CALLBACK = process.env.FLW_TRANSFER_CALLBACK_URL;

const SEND_EVERY_MS = Number(process.env.WORKER_SEND_INTERVAL_MS || 5_000);
const RECONCILE_EVERY_MS = Number(process.env.WORKER_RECONCILE_INTERVAL_MS || 60_000);
const BATCH = Number(process.env.WORKER_BATCH || 5);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- supabase

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error(`${fn} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
}

// ---------------------------------------------------------------- flutterwave

async function flw(path, init = {}) {
  let res;
  try {
    res = await fetch(`${FLW_BASE}${path}`, {
      method: init.method || 'GET',
      headers: {
        Authorization: `Bearer ${FLW_KEY}`,
        'Content-Type': 'application/json',
        ...(init.reference ? { 'X-Idempotency-Key': init.reference } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Unreachable or timed out. We know NOTHING about the transfer's fate.
    return { unreachable: true, ok: false, status: 0, message: String(err?.message ?? err), data: null };
  }
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
  return {
    unreachable: false,
    ok: res.ok && json.status === 'success',
    status: res.status,
    message: typeof json.message === 'string' ? json.message : `HTTP ${res.status}`,
    data: json.data ?? null,
  };
}

// ---------------------------------------------------------------- send pass

async function sendPass() {
  const claimed = await rpc('claim_withdrawals', { p_limit: BATCH });
  if (!claimed?.length) return 0;

  for (const w of claimed) {
    // The payout destination. Read per row so a deleted account is caught here
    // rather than sending money into the void.
    const accounts = await fetch(
      `${SUPABASE_URL}/rest/v1/bank_accounts?id=eq.${w.bank_account_id}&select=bank_code,account_number,account_name`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    ).then((r) => r.json());
    const acct = accounts?.[0];

    if (!acct) {
      log(`[send] ${w.reference} has no payout account — failing and refunding`);
      await rpc('settle_withdrawal', {
        p_reference: w.reference, p_outcome: 'failed',
        p_flw_status: 'no_account', p_reason: 'payout account no longer exists',
      });
      continue;
    }

    log(`[send] ${w.reference} NGN ${koboToNaira(w.net_kobo)} -> ${acct.account_name} (${acct.bank_code}/${acct.account_number.slice(-4)})`);

    const res = await flw('/transfers', {
      method: 'POST',
      reference: w.reference,
      body: {
        account_bank: acct.bank_code,
        account_number: acct.account_number,
        amount: koboToNaira(w.net_kobo),
        currency: 'NGN',
        debit_currency: 'NGN',
        reference: w.reference,
        narration: 'Dice Duel payout',
        callback_url: CALLBACK,
      },
    });

    // --- the branch where money is won or lost --------------------------
    if (res.unreachable) {
      // Could not reach Flutterwave. The transfer may or may not exist. Leave
      // the row in 'processing' and let the reconciler find out.
      log(`[send] ${w.reference} unreachable (${res.message}) — left for reconcile`);
      continue;
    }

    if (!res.ok) {
      const created = res.data?.id;
      if (!created) {
        // Explicit rejection and nothing was created, so no money is in flight.
        log(`[send] ${w.reference} rejected: ${res.message} — refunding`);
        await rpc('settle_withdrawal', {
          p_reference: w.reference, p_outcome: 'failed',
          p_flw_status: String(res.status), p_reason: res.message,
        });
      } else {
        // Something exists on their side. Only the reconciler may judge it.
        log(`[send] ${w.reference} rejected but transfer ${created} exists — reconciling`);
        await rpc('mark_withdrawal_sent', {
          p_reference: w.reference, p_flw_transfer_id: created, p_flw_status: res.message,
        });
      }
      continue;
    }

    await rpc('mark_withdrawal_sent', {
      p_reference: w.reference,
      p_flw_transfer_id: res.data?.id ?? null,
      p_flw_status: res.data?.status ?? 'PENDING',
    });

    // Usually NEW/PENDING here; settle only if already terminal.
    const outcome = terminalStatus(res.data?.status);
    if (outcome) {
      await rpc('settle_withdrawal', {
        p_reference: w.reference, p_outcome: outcome,
        p_flw_status: res.data?.status ?? '', p_reason: res.data?.complete_message ?? null,
      });
      log(`[send] ${w.reference} settled immediately as ${outcome}`);
    } else {
      log(`[send] ${w.reference} accepted as ${res.data?.status ?? 'PENDING'} (transfer ${res.data?.id})`);
    }
  }
  return claimed.length;
}

// ---------------------------------------------------------------- reconcile

async function reconcilePass() {
  const rows = await rpc('withdrawals_to_reconcile', {});
  if (!rows?.length) return 0;

  for (const w of rows) {
    const res = w.flw_transfer_id
      ? await flw(`/transfers/${w.flw_transfer_id}`)
      : await flw(`/transfers?reference=${encodeURIComponent(w.reference)}`);

    if (res.unreachable) {
      log(`[reconcile] ${w.reference} — Flutterwave unreachable, leaving as is`);
      continue;
    }

    const transfer = Array.isArray(res.data) ? res.data[0] : res.data;

    if (!transfer) {
      // Flutterwave has no record. Only safe to fail once the row has waited
      // out the missing-grace, re-checked in SQL so the decision is never made
      // on this process's clock alone.
      const mayFail = await rpc('withdrawal_may_be_declared_missing', { p_reference: w.reference });
      if (!mayFail) {
        log(`[reconcile] ${w.reference} not found yet — still inside grace, waiting`);
        continue;
      }
      log(`[reconcile] ${w.reference} does not exist at Flutterwave — failing and refunding`);
      await rpc('settle_withdrawal', {
        p_reference: w.reference, p_outcome: 'failed',
        p_flw_status: 'not_found_at_psp', p_reason: 'no transfer exists for this reference',
      });
      continue;
    }

    const outcome = terminalStatus(transfer.status);
    if (!outcome) {
      log(`[reconcile] ${w.reference} still ${transfer.status} — waiting`);
      continue;
    }

    const result = await rpc('settle_withdrawal', {
      p_reference: w.reference, p_outcome: outcome,
      p_flw_status: transfer.status, p_reason: transfer.complete_message ?? null,
    });
    log(`[reconcile] ${w.reference} ${transfer.status} -> ${result}`);
  }
  return rows.length;
}

// ---------------------------------------------------------------- loop

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(`[worker] ${sig} — finishing current pass`); stopping = true; });
}

async function safely(name, fn) {
  try {
    return await fn();
  } catch (err) {
    // Never let one bad pass kill the worker; a dead worker means payouts stop.
    console.error(new Date().toISOString(), `[${name}] error:`, err?.message ?? err);
    return 0;
  }
}

async function main() {
  log(`[worker] started · send every ${SEND_EVERY_MS}ms · reconcile every ${RECONCILE_EVERY_MS}ms`);
  log(`[worker] supabase ${SUPABASE_URL}`);

  // Announce the egress IP: this is the address to whitelist with Flutterwave.
  try {
    const ip = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) }).then((r) => r.text());
    log(`[worker] egress IP ${ip} — whitelist THIS with Flutterwave`);
  } catch { log('[worker] could not determine egress IP'); }

  let lastReconcile = 0;
  while (!stopping) {
    await safely('send', sendPass);

    if (Date.now() - lastReconcile >= RECONCILE_EVERY_MS) {
      lastReconcile = Date.now();
      await safely('reconcile', reconcilePass);
    }

    await new Promise((r) => setTimeout(r, SEND_EVERY_MS));
  }
  log('[worker] stopped');
}

// Run once and exit, for cron-style hosts: WORKER_ONCE=1
if (process.env.WORKER_ONCE === '1') {
  await safely('send', sendPass);
  await safely('reconcile', reconcilePass);
  log('[worker] single pass complete');
  process.exit(0);
} else {
  await main();
}
