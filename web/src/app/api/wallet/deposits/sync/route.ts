import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { verifyAndCredit, type DepositRow } from '@/lib/deposit-recovery';

export const dynamic = 'force-dynamic';

/**
 * Check the CALLER'S OWN pending deposits and credit any that settled.
 *
 * Called by the wallet page on load, and immediately when a player returns from
 * Flutterwave's checkout. This is the recovery path that matters most in
 * practice: the person most motivated to notice an uncredited payment is the
 * one who made it, and they are already on the page.
 *
 * It is safe to call as often as you like — credit_deposit is idempotent, and
 * this only ever touches deposits belonging to the signed-in player.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  const { data, error } = await supabase.rpc('my_pending_deposits');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const pending = (data ?? []) as DepositRow[];
  const results: Record<string, string> = {};
  let credited = 0;

  for (const d of pending) {
    const outcome = await verifyAndCredit(d.reference);
    results[d.reference] = outcome;
    if (outcome === 'credited') credited++;
  }

  return NextResponse.json({ checked: pending.length, credited, results });
}
