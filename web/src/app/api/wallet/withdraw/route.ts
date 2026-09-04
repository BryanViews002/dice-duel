import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Request a payout.
 *
 * This route deliberately does NOT talk to Flutterwave. It locks the funds,
 * writes a 'requested' row, and returns. The payout worker (worker/index.mjs),
 * which runs on a host with a fixed, whitelisted IP, picks the row up and
 * initiates the transfer.
 *
 * Two reasons it is built this way:
 *
 *   1. Flutterwave gates transfers behind IP whitelisting, and Vercel
 *      serverless has no stable egress address to whitelist.
 *
 *   2. Even without that, a user's HTTP request should never block on a bank
 *      API. Doing so put a slow, failure-prone third party inside the request
 *      that moves their money — the request could time out in the browser while
 *      the transfer went ahead perfectly well, and the user would have no idea
 *      what state they were in.
 *
 * What matters for correctness happens here regardless: request_withdrawal()
 * debits the balance and writes the row in ONE transaction, guarded by a unique
 * index that permits a single live withdrawal per player. Once this returns,
 * the money is out of the spendable balance and a second request is impossible
 * — whether or not the worker has run yet.
 */
export async function POST(request: NextRequest) {
  // Who is asking is decided by THEIR session, never by the request body.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  let body: { amountKobo?: unknown; bankAccountId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const amountKobo = Number(body.amountKobo);
  const bankAccountId = String(body.bankAccountId ?? '');

  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    return NextResponse.json({ error: 'Enter a valid amount.' }, { status: 400 });
  }
  if (!bankAccountId) {
    return NextResponse.json({ error: 'Choose a payout account.' }, { status: 400 });
  }

  // Generated once, stored before anything else happens, and reused by the
  // worker on every retry. A fresh reference on retry is how one payout
  // becomes two.
  const reference = `dd-wd-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

  // Runs as the PLAYER, so request_withdrawal's auth.uid() checks apply and
  // every limit, balance and wagering rule is enforced by the database.
  const { data: rows, error } = await supabase.rpc('request_withdrawal', {
    p_amount_kobo: amountKobo,
    p_bank_account_id: bankAccountId,
    p_reference: reference,
  });

  if (error) {
    // These are the deliberate, user-facing RAISEs from request_withdrawal.
    return NextResponse.json(
      { error: error.message.replace(/^.*?:\s*/, '') },
      { status: 400 },
    );
  }

  const withdrawal = Array.isArray(rows) ? rows[0] : rows;
  if (!withdrawal) {
    return NextResponse.json({ error: 'Could not open the withdrawal.' }, { status: 500 });
  }

  return NextResponse.json({
    status: withdrawal.status,
    reference,
    netKobo: withdrawal.net_kobo,
    feeKobo: withdrawal.fee_kobo,
    message:
      withdrawal.status === 'review'
        ? 'This payout is above the automatic limit and is queued for review. ' +
          'Your funds are already reserved and cannot be spent while it is pending.'
        : 'Payout requested. Your funds are reserved and the transfer is being sent — ' +
          'you can follow it above.',
  });
}
