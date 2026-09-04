import 'server-only';
import { verifyChargeByReference, nairaToKobo } from '@/lib/flutterwave';
import { createAdminClient } from '@/lib/supabase/admin';

export type DepositRow = { reference: string; amount_kobo: number; created_at: string };

/**
 * Verify one pending deposit against Flutterwave and credit it if it settled.
 *
 * This is the shared core of every recovery path — the player returning from
 * checkout, and the scheduled sweep. Both converge here, and here converges on
 * credit_deposit(), which is idempotent. So a deposit racing all three at once
 * is credited exactly once.
 *
 * The amount credited is ALWAYS the one Flutterwave reports, never the one the
 * player asked for. A charge that settles for less than requested is a mismatch
 * and is failed rather than part-credited.
 */
export async function verifyAndCredit(reference: string): Promise<string> {
  const charge = await verifyChargeByReference(reference);

  if (charge.networkError) {
    // We could not ask. Leave it pending; a later pass will try again. Marking
    // it failed here would strand a payment the player actually made.
    return 'unreachable';
  }

  // Flutterwave has no record of the reference at all.
  if (!charge.data) {
    return 'not_found';
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('credit_deposit', {
    p_reference: reference,
    p_flw_tx_id: charge.data.id ?? null,
    p_verified_amount_kobo: nairaToKobo(charge.data.amount),
    p_flw_status: charge.data.status ?? 'unknown',
  });

  if (error) {
    console.error('[deposit-recovery] credit_deposit failed', reference, error.message);
    return 'error';
  }
  return String(data);
}
