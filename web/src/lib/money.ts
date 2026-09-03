/**
 * Pure money + payout-status logic. No secrets, no I/O, no `server-only` — so
 * it can be unit tested directly, which matters because these three functions
 * are where payout bugs actually live.
 */

/**
 * kobo (integer minor units, how everything is stored) -> naira (decimal, what
 * Flutterwave's API expects).
 *
 * This and nairaToKobo are the ONLY sanctioned conversions in the codebase.
 * Anywhere else multiplying or dividing money by 100 is a bug waiting to pay
 * someone 100x.
 */
export function koboToNaira(kobo: number): number {
  if (!Number.isInteger(kobo)) throw new Error(`kobo must be an integer, got ${kobo}`);
  return Math.round(kobo) / 100;
}

/** naira (decimal, from Flutterwave) -> kobo (integer). */
export function nairaToKobo(naira: number | string): number {
  const n = typeof naira === 'string' ? Number(naira) : naira;
  if (!Number.isFinite(n)) throw new Error(`bad naira amount: ${naira}`);
  // Round, never truncate: 1234.56 * 100 === 123455.99999999999 in binary float,
  // and Math.trunc would quietly lose a kobo on a large fraction of amounts.
  return Math.round(n * 100);
}

/**
 * Map a Flutterwave transfer status onto one of our terminal outcomes.
 *
 * `null` means NOT TERMINAL and must never be settled.
 *
 * This is the single most dangerous function in the payout path. Returning
 * 'failed' for a status that is merely pending — or for one we simply do not
 * recognise — makes us refund a player whose transfer then completes. They keep
 * the cash and the balance, and nothing in the system notices. Defaulting to
 * null means the worst case is a payout that takes longer to resolve, which is
 * recoverable; the alternative is not.
 */
export function terminalStatus(flwStatus: string | undefined | null): 'paid' | 'failed' | null {
  switch ((flwStatus ?? '').toUpperCase()) {
    case 'SUCCESSFUL':
    case 'SUCCESS':
      return 'paid';
    case 'FAILED':
      return 'failed';
    // NEW, PENDING, PROCESSING, ABANDONED, '', and anything unrecognised.
    default:
      return null;
  }
}
