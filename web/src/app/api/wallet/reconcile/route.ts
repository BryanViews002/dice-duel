import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchTransfer, fetchTransfersByReference, terminalStatus } from '@/lib/flutterwave';

export const dynamic = 'force-dynamic';

/**
 * The reconciler. Run it on a schedule — every minute or two.
 *
 * THIS IS THE MOST IMPORTANT PIECE OF THE PAYOUT SYSTEM, and it is the piece
 * most implementations leave out. Webhooks are best-effort: they get dropped,
 * delayed past any reasonable timeout, delivered out of order, or silently
 * blackholed while you are redeploying. Every "withdrawal stuck pending
 * forever" story is a system that had no reconciler.
 *
 * Nothing here depends on a webhook ever arriving. For each withdrawal that has
 * been sitting non-terminal past the grace period, we ask Flutterwave what
 * actually happened and apply it through the same idempotent settle path the
 * webhook uses. If both run at once, the second is a no-op.
 *
 * Two subtleties worth keeping:
 *
 *  - A row stuck in 'requested' means we may never have reached Flutterwave.
 *    We look it up BY OUR REFERENCE, because we might not have a transfer id.
 *    If Flutterwave has never heard of it, no money moved and it is safe to
 *    fail and refund. That lookup is the only reason it is safe.
 *
 *  - Pending stays pending. Ageing is not evidence of failure. A transfer can
 *    sit PENDING for hours over a weekend; timing it out and refunding is how
 *    you pay someone twice.
 */
export async function POST(request: NextRequest) {
  // Protect the endpoint: it is triggered by cron, not by users.
  const secret = process.env.RECONCILE_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'RECONCILE_SECRET is not set' }, { status: 500 });
  }
  const provided = request.headers.get('x-reconcile-secret') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();

  const { data: stale, error } = await admin.rpc('stale_withdrawals', {
    p_older_than: '2 minutes',
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (stale ?? []) as {
    reference: string;
    flw_transfer_id: number | null;
    status: string;
    attempts: number;
  }[];

  const report: Record<string, string> = {};

  for (const w of rows) {
    // Prefer the id; fall back to our own reference when we never got one.
    const looked = w.flw_transfer_id
      ? await fetchTransfer(w.flw_transfer_id)
      : await fetchTransfersByReference(w.reference);

    if (looked.networkError) {
      report[w.reference] = 'flutterwave unreachable — left as is';
      continue;
    }

    const transfer = Array.isArray(looked.data) ? looked.data[0] : looked.data;

    // Flutterwave has no record of this reference at all. Nothing was ever
    // created, so no money can be in flight: fail it and give the funds back.
    if (!transfer) {
      const r = await admin.rpc('settle_withdrawal', {
        p_reference: w.reference,
        p_outcome: 'failed',
        p_flw_status: 'not_found_at_psp',
        p_reason: 'no transfer exists for this reference; nothing was sent',
      });
      report[w.reference] = `no record at PSP -> ${r.data ?? r.error?.message}`;
      continue;
    }

    const outcome = terminalStatus(transfer.status);
    if (!outcome) {
      // Genuinely still in flight. Leave it. Age is not failure.
      report[w.reference] = `still ${transfer.status} — waiting`;
      continue;
    }

    const r = await admin.rpc('settle_withdrawal', {
      p_reference: w.reference,
      p_outcome: outcome,
      p_flw_status: transfer.status,
      p_reason: transfer.complete_message ?? null,
    });
    report[w.reference] = `${transfer.status} -> ${r.data ?? r.error?.message}`;
  }

  return NextResponse.json({ checked: rows.length, report });
}
