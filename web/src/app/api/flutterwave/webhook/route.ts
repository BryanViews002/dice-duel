import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  verifyWebhookSignature,
  verifyChargeByReference,
  fetchTransfer,
  fetchTransfersByReference,
  terminalStatus,
  nairaToKobo,
} from '@/lib/flutterwave';

export const dynamic = 'force-dynamic';

/**
 * Flutterwave webhook.
 *
 * Three rules, each of which exists because breaking it loses money:
 *
 *  1. VERIFY THE SIGNATURE FIRST. An unauthenticated endpoint that settles
 *     payouts is a gift: forge "transfer failed" on a payout that actually
 *     settled and we refund a player who already has the cash; forge
 *     "charge completed" and mint balance from nothing.
 *
 *  2. NEVER TRUST THE PAYLOAD'S NUMBERS. The webhook body says how much was
 *     paid; we ask Flutterwave's API instead and credit that. A webhook is a
 *     notification that something happened, not evidence of what happened.
 *
 *  3. ALWAYS RETURN 2xx ONCE THE EVENT IS ACCEPTED. Flutterwave retries on
 *     non-2xx. Since every settlement path is idempotent, retries are harmless
 *     — but returning 500 on an event we have already processed produces an
 *     endless retry storm. A 200 with a body explaining the no-op is correct.
 */
export async function POST(request: NextRequest) {
  // ---- 1: authenticate the sender ----------------------------------------
  let signatureOk = false;
  try {
    signatureOk = verifyWebhookSignature(request.headers.get('verif-hash'));
  } catch (err) {
    // FLW_WEBHOOK_HASH missing — a configuration fault, not a bad request.
    console.error('[flw webhook] not configured:', err);
    return NextResponse.json({ error: 'webhook not configured' }, { status: 500 });
  }
  if (!signatureOk) {
    console.warn('[flw webhook] rejected: bad or missing verif-hash');
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let event: {
    event?: string;
    'event.type'?: string;
    data?: Record<string, unknown>;
  };
  try {
    event = await request.json();
  } catch {
    return NextResponse.json({ error: 'malformed body' }, { status: 400 });
  }

  const kind = String(event.event ?? event['event.type'] ?? '');
  const data = event.data ?? {};
  const admin = createAdminClient();

  // ---------------------------------------------------------------- charges
  if (kind.startsWith('charge')) {
    const reference = String(data.tx_ref ?? '');
    if (!reference) return NextResponse.json({ ok: true, note: 'no tx_ref' });

    // Rule 2: re-verify with the API rather than believing the body.
    const verified = await verifyChargeByReference(reference);
    if (verified.networkError) {
      // Ask for a retry — we genuinely could not check.
      return NextResponse.json({ error: 'verification unavailable' }, { status: 503 });
    }

    const charge = verified.data;
    const result = await admin.rpc('credit_deposit', {
      p_reference: reference,
      p_flw_tx_id: charge?.id ?? null,
      p_verified_amount_kobo: charge ? nairaToKobo(charge.amount) : 0,
      p_flw_status: charge?.status ?? 'unverified',
    });

    if (result.error) {
      console.error('[flw webhook] credit_deposit failed', reference, result.error.message);
      return NextResponse.json({ error: 'settlement failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, reference, result: result.data });
  }

  // -------------------------------------------------------------- transfers
  if (kind.startsWith('transfer')) {
    const reference = String(data.reference ?? '');
    const transferId = Number(data.id ?? 0);
    if (!reference && !transferId) return NextResponse.json({ ok: true, note: 'no reference' });

    // Rule 2 again: confirm the transfer's real status with the API.
    const looked = transferId
      ? await fetchTransfer(transferId)
      : await fetchTransfersByReference(reference);

    if (looked.networkError) {
      return NextResponse.json({ error: 'verification unavailable' }, { status: 503 });
    }

    const transfer = Array.isArray(looked.data) ? looked.data[0] : looked.data;
    const ref = reference || transfer?.reference;
    if (!ref) return NextResponse.json({ ok: true, note: 'unresolvable' });

    // A transfer that settled and was later pulled back by the bank.
    const isReversal = /revers/i.test(kind) || /revers/i.test(String(transfer?.status ?? ''));
    if (isReversal) {
      const r = await admin.rpc('settle_withdrawal', {
        p_reference: ref,
        p_outcome: 'reversed',
        p_flw_status: String(transfer?.status ?? 'REVERSED'),
        p_reason: transfer?.complete_message ?? 'reversed by bank',
      });
      return NextResponse.json({ ok: true, reference: ref, result: r.data });
    }

    const outcome = terminalStatus(transfer?.status);
    if (!outcome) {
      // Still pending. Recording a non-terminal state as terminal here is the
      // single most expensive mistake available, so we simply acknowledge.
      return NextResponse.json({
        ok: true,
        reference: ref,
        note: `not terminal (${transfer?.status ?? 'unknown'}) — left for the reconciler`,
      });
    }

    const r = await admin.rpc('settle_withdrawal', {
      p_reference: ref,
      p_outcome: outcome,
      p_flw_status: String(transfer?.status ?? ''),
      p_reason: transfer?.complete_message ?? null,
    });

    if (r.error) {
      console.error('[flw webhook] settle_withdrawal failed', ref, r.error.message);
      return NextResponse.json({ error: 'settlement failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, reference: ref, result: r.data });
  }

  return NextResponse.json({ ok: true, note: `ignored event ${kind}` });
}
