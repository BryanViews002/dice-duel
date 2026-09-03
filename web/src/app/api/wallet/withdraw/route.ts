import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { initiateTransfer, terminalStatus } from '@/lib/flutterwave';

export const dynamic = 'force-dynamic';

/**
 * Request a payout.
 *
 * THE ORDER OF OPERATIONS HERE IS THE WHOLE POINT. Read it before changing it.
 *
 *   1. request_withdrawal() debits the player and writes the row, inside one
 *      transaction, guarded by a unique index that permits one live withdrawal
 *      per player. After this returns, the money is already out of the
 *      spendable balance and a second request is impossible.
 *
 *   2. The reference is generated BEFORE Flutterwave is called and stored in
 *      step 1. If anything below explodes, the row still exists with that
 *      reference, and the reconciler can find out what really happened.
 *
 *   3. Only then do we call Flutterwave.
 *
 * And the rule that actually stops money leaking:
 *
 *   A FAILED API CALL IS NOT A FAILED TRANSFER.
 *
 * A timeout, a 502, or a dropped connection tells us nothing about whether the
 * transfer was created. If we refunded on those, the transfer could still
 * settle and the player would keep both the cash and the balance. So anything
 * that is not an explicit, terminal rejection leaves the row in 'processing'
 * for the reconciler to resolve against Flutterwave itself.
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

  // Generated once. Reused on every retry, forever. Never regenerated — a new
  // reference on retry is how one payout becomes two.
  const reference = `dd-wd-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

  // ---- 1 & 2: lock the funds and persist the reference -------------------
  // Runs as the PLAYER, so request_withdrawal's auth.uid() checks apply and
  // every limit, balance and wagering rule is enforced by the database.
  const { data: rows, error: reqErr } = await supabase.rpc('request_withdrawal', {
    p_amount_kobo: amountKobo,
    p_bank_account_id: bankAccountId,
    p_reference: reference,
  });

  if (reqErr) {
    // These are the deliberate, user-facing RAISEs from request_withdrawal.
    return NextResponse.json(
      { error: reqErr.message.replace(/^.*?:\s*/, '') },
      { status: 400 },
    );
  }

  const withdrawal = Array.isArray(rows) ? rows[0] : rows;
  if (!withdrawal) {
    return NextResponse.json({ error: 'Could not open the withdrawal.' }, { status: 500 });
  }

  // Held for a human. Funds are already locked; nothing is sent yet.
  if (withdrawal.status === 'review') {
    return NextResponse.json({
      status: 'review',
      reference,
      message:
        'This payout is above the automatic limit and is queued for review. ' +
        'The funds are already reserved and cannot be spent while it is pending.',
    });
  }

  const admin = createAdminClient();

  // Payout destination. Read with the service client because we need the bank
  // details, but scoped to this player's own row.
  const { data: account } = await admin
    .from('bank_accounts')
    .select('bank_code, account_number, account_name')
    .eq('id', bankAccountId)
    .eq('player_id', user.id)
    .maybeSingle();

  if (!account) {
    await admin.rpc('settle_withdrawal', {
      p_reference: reference,
      p_outcome: 'failed',
      p_flw_status: 'no_account',
      p_reason: 'payout account disappeared between request and transfer',
    });
    return NextResponse.json({ error: 'That payout account is no longer available.' }, { status: 400 });
  }

  // ---- 3: hand it to Flutterwave ----------------------------------------
  const transfer = await initiateTransfer({
    reference,
    bankCode: account.bank_code,
    accountNumber: account.account_number,
    amountKobo: withdrawal.net_kobo,
    narration: 'Dice Duel payout',
    callbackUrl: process.env.FLW_TRANSFER_CALLBACK_URL,
  });

  // --- the branch that decides whether money leaks -----------------------

  if (transfer.networkError) {
    // We do NOT know whether the transfer was created. Leave it processing and
    // let the reconciler ask Flutterwave. Refunding here would be the bug.
    await admin.rpc('mark_withdrawal_sent', {
      p_reference: reference,
      p_flw_transfer_id: null,
      p_flw_status: 'unknown_network_error',
    });
    return NextResponse.json({
      status: 'processing',
      reference,
      message:
        'Your payout was submitted but the bank network did not confirm in time. ' +
        'It is being checked automatically — do not request it again.',
    });
  }

  if (!transfer.ok) {
    // An explicit rejection with no transfer id means Flutterwave did not
    // create anything, so it is safe to refund. If an id came back, something
    // exists on their side and only the reconciler may decide its fate.
    const created = transfer.data?.id;
    if (!created) {
      await admin.rpc('settle_withdrawal', {
        p_reference: reference,
        p_outcome: 'failed',
        p_flw_status: String(transfer.status),
        p_reason: transfer.message,
      });
      return NextResponse.json(
        { error: transfer.message || 'The bank rejected this payout. Your balance is unchanged.' },
        { status: 400 },
      );
    }

    await admin.rpc('mark_withdrawal_sent', {
      p_reference: reference,
      p_flw_transfer_id: created,
      p_flw_status: transfer.message,
    });
    return NextResponse.json({ status: 'processing', reference });
  }

  // Accepted. Note this is usually NEW/PENDING, not SUCCESSFUL — settlement
  // comes later, via webhook or reconciler.
  await admin.rpc('mark_withdrawal_sent', {
    p_reference: reference,
    p_flw_transfer_id: transfer.data?.id ?? null,
    p_flw_status: transfer.data?.status ?? 'PENDING',
  });

  // Only settle here if Flutterwave already reported a terminal state.
  const settled = terminalStatus(transfer.data?.status);
  if (settled) {
    await admin.rpc('settle_withdrawal', {
      p_reference: reference,
      p_outcome: settled,
      p_flw_status: transfer.data?.status ?? '',
      p_reason: transfer.data?.complete_message ?? null,
    });
  }

  return NextResponse.json({
    status: settled ?? 'processing',
    reference,
    netKobo: withdrawal.net_kobo,
    feeKobo: withdrawal.fee_kobo,
    accountName: account.account_name,
  });
}
