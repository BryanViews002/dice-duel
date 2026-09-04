import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAndCredit, type DepositRow } from '@/lib/deposit-recovery';

export const dynamic = 'force-dynamic';

/**
 * Scheduled sweep of every pending deposit, for players who paid and closed the
 * tab before anything could credit them.
 *
 * Point any cron at this every few minutes with the x-reconcile-secret header —
 * Vercel Cron, cron-job.org, GitHub Actions, anything. Nothing depends on a
 * webhook arriving, which is the whole point: webhooks are an optimisation,
 * never the source of truth.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.RECONCILE_SECRET;
  if (!secret) return NextResponse.json({ error: 'RECONCILE_SECRET not set' }, { status: 500 });

  const provided = request.headers.get('x-reconcile-secret') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('deposits_to_verify', {
    p_older_than: '90 seconds',
    p_limit: 50,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const pending = (data ?? []) as DepositRow[];
  const results: Record<string, string> = {};
  let credited = 0;

  for (const d of pending) {
    const outcome = await verifyAndCredit(d.reference);
    results[d.reference] = outcome;
    if (outcome === 'credited') credited++;
  }

  // Nothing older than three days can still be an open checkout session.
  const { data: abandoned } = await admin.rpc('abandon_stale_deposits', {
    p_older_than: '3 days',
  });

  return NextResponse.json({
    checked: pending.length,
    credited,
    abandoned: abandoned ?? 0,
    results,
  });
}

export const GET = POST;
