import 'server-only';
import crypto from 'node:crypto';
import { koboToNaira, nairaToKobo, terminalStatus } from './money';

export { koboToNaira, nairaToKobo, terminalStatus };

/**
 * Flutterwave v3 client. Server-side only — `server-only` makes importing this
 * from a client component a build error, because FLW_SECRET_KEY must never
 * reach the browser.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * The database stores kobo (integer minor units). Flutterwave denominates NGN
 * in NAIRA (major units, decimal). Getting this wrong pays out 100x or 1/100th.
 *
 * koboToNaira() below is the ONLY place that conversion is allowed to happen.
 * Nothing else in the codebase should multiply or divide a money value by 100.
 *
 * ── VERSION NOTE ───────────────────────────────────────────────────────────
 * Field names and endpoints follow Flutterwave v3 as of writing. Payment APIs
 * do change — check these against the current docs before going live, and treat
 * a 4xx with an unexpected shape as a signal the contract moved, not as a
 * transfer failure. `rawResponse` is preserved on every result so you can see
 * exactly what came back.
 */

const BASE = process.env.FLW_BASE_URL || 'https://api.flutterwave.com/v3';

/**
 * Optional static-IP egress proxy.
 *
 * Flutterwave gates the Transfers API behind IP whitelisting, and Vercel's
 * serverless functions egress from a large, changing pool of addresses — there
 * is nothing stable to whitelist. Without a fixed egress IP every payout comes
 * back as:
 *
 *     400  "Please enable IP Whitelisting to access this service"
 *
 * Set FLW_PROXY_URL to a proxy with a static IP (QuotaGuard, Fixie, or your own
 * small VPS running tinyproxy/squid) and whitelist THAT address with
 * Flutterwave. Reads and account lookups do not need it, but routing everything
 * through one egress keeps the whitelist to a single entry.
 *
 * Unset in local development, where your own IP is the one you whitelist.
 */
let proxyDispatcher: unknown;
async function dispatcher(): Promise<unknown> {
  const url = process.env.FLW_PROXY_URL;
  if (!url) return undefined;
  if (!proxyDispatcher) {
    const { ProxyAgent } = await import('undici');
    proxyDispatcher = new ProxyAgent(url);
  }
  return proxyDispatcher;
}

function secretKey(): string {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new Error('FLW_SECRET_KEY is not set');
  return key;
}

export type FlwResult<T> = {
  ok: boolean;
  /** true only when we know the request never reached Flutterwave. */
  networkError: boolean;
  status: number;
  message: string;
  data: T | null;
  raw: unknown;
};

async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
): Promise<FlwResult<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey()}`,
    'Content-Type': 'application/json',
  };
  // Flutterwave keys transfers on `reference`; this header is belt-and-braces
  // for any endpoint that honours it.
  if (init.idempotencyKey) headers['X-Idempotency-Key'] = init.idempotencyKey;

  const agent = await dispatcher();

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      // Routes this call out through the static-IP proxy when configured.
      ...(agent ? { dispatcher: agent } : {}),
      // A transfer that times out has NOT necessarily failed. Keep this
      // generous, and treat a timeout as "unknown", never as "failed".
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    });
  } catch (err) {
    return {
      ok: false,
      networkError: true,
      status: 0,
      message: err instanceof Error ? err.message : 'network error',
      data: null,
      raw: null,
    };
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON body */ }

  return {
    ok: res.ok && json.status === 'success',
    networkError: false,
    status: res.status,
    message: typeof json.message === 'string' ? json.message : `HTTP ${res.status}`,
    data: (json.data as T) ?? null,
    raw: json,
  };
}

// ---------------------------------------------------------------- banks

export type Bank = { id: number; code: string; name: string };

export function listBanks() {
  return call<Bank[]>('/banks/NG', { method: 'GET' });
}

export type ResolvedAccount = { account_number: string; account_name: string };

/**
 * Resolve an account number to its registered name.
 *
 * Always do this before saving a payout destination. A transfer to a wrong but
 * valid account number succeeds — the money simply goes to a stranger, and it
 * is not recoverable. The resolved name is the only check that the destination
 * is who the user thinks it is.
 */
export function resolveAccount(accountNumber: string, bankCode: string) {
  return call<ResolvedAccount>('/accounts/resolve', {
    method: 'POST',
    body: { account_number: accountNumber, account_bank: bankCode },
  });
}

// ---------------------------------------------------------------- deposits

export type PaymentLink = { link: string };

export function createPaymentLink(args: {
  reference: string;
  amountKobo: number;
  email: string;
  name: string;
  redirectUrl: string;
}) {
  return call<PaymentLink>('/payments', {
    method: 'POST',
    idempotencyKey: args.reference,
    body: {
      tx_ref: args.reference,
      amount: koboToNaira(args.amountKobo),
      currency: 'NGN',
      redirect_url: args.redirectUrl,
      customer: { email: args.email, name: args.name },
      customizations: { title: 'Dice Duel', description: 'Add funds to your balance' },
    },
  });
}

export type VerifiedCharge = {
  id: number;
  tx_ref: string;
  status: string;
  amount: number;
  currency: string;
  charged_amount: number;
};

/** Verify a charge against Flutterwave. Never credit from webhook data alone. */
export function verifyChargeByReference(reference: string) {
  return call<VerifiedCharge>(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, {
    method: 'GET',
  });
}

// ---------------------------------------------------------------- transfers

export type Transfer = {
  id: number;
  reference: string;
  status: string;          // NEW | PENDING | SUCCESSFUL | FAILED
  complete_message?: string;
  amount: number;
};

export function initiateTransfer(args: {
  reference: string;
  bankCode: string;
  accountNumber: string;
  amountKobo: number;
  narration: string;
  callbackUrl?: string;
}) {
  return call<Transfer>('/transfers', {
    method: 'POST',
    idempotencyKey: args.reference,
    body: {
      account_bank: args.bankCode,
      account_number: args.accountNumber,
      amount: koboToNaira(args.amountKobo),
      currency: 'NGN',
      debit_currency: 'NGN',
      reference: args.reference,
      narration: args.narration,
      callback_url: args.callbackUrl,
    },
  });
}

export function fetchTransfer(flwTransferId: number) {
  return call<Transfer>(`/transfers/${flwTransferId}`, { method: 'GET' });
}

/** Look a transfer up by OUR reference — the path used when we never got an id. */
export function fetchTransfersByReference(reference: string) {
  return call<Transfer[]>(`/transfers?reference=${encodeURIComponent(reference)}`, { method: 'GET' });
}

// ---------------------------------------------------------------- webhooks

/**
 * Verify the `verif-hash` header against FLW_WEBHOOK_HASH.
 *
 * Without this, anyone who learns the endpoint can POST a forged
 * "transfer failed" and have us refund a payout that actually settled — or
 * forge a "charge completed" and mint balance outright. Compared in constant
 * time so the hash cannot be recovered a byte at a time.
 */
export function verifyWebhookSignature(headerHash: string | null): boolean {
  const expected = process.env.FLW_WEBHOOK_HASH;
  if (!expected) throw new Error('FLW_WEBHOOK_HASH is not set');
  if (!headerHash) return false;

  const a = Buffer.from(headerHash);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
