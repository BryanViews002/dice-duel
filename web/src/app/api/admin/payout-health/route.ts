import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * Payout queue health, for an uptime monitor to poll.
 *
 * In manual payout mode a stalled queue is a player waiting on their money with
 * nobody alerted. Point UptimeRobot / cron-job.org / Better Stack at this with
 * the x-reconcile-secret header; it returns HTTP 503 once a payout has been
 * waiting past the threshold, which is what turns a silent queue into a page.
 *
 *   GET /api/admin/payout-health?minutes=30
 */
export async function GET(request: NextRequest) {
  const secret = process.env.RECONCILE_SECRET;
  if (!secret) return NextResponse.json({ error: 'RECONCILE_SECRET not set' }, { status: 500 });

  const provided = request.headers.get('x-reconcile-secret') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const threshold = Number(request.nextUrl.searchParams.get('minutes') ?? 30);
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('payout_health');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const h = (Array.isArray(data) ? data[0] : data) as {
    waiting: number; oldest_minutes: number; total_waiting_kobo: number; breaching: number;
  };

  const stalled = h.oldest_minutes > threshold;

  return NextResponse.json(
    {
      ok: !stalled,
      waiting: h.waiting,
      oldestMinutes: h.oldest_minutes,
      totalWaitingNaira: h.total_waiting_kobo / 100,
      breaching: h.breaching,
      thresholdMinutes: threshold,
      message: stalled
        ? `A payout has been waiting ${h.oldest_minutes} minutes. Settle it at /admin/payouts.`
        : h.waiting === 0 ? 'Queue empty.' : `${h.waiting} waiting, oldest ${h.oldest_minutes}m.`,
    },
    // Non-2xx is what makes an uptime monitor actually alert.
    { status: stalled ? 503 : 200 },
  );
}
