import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { listBanks, resolveAccount } from '@/lib/flutterwave';

export const dynamic = 'force-dynamic';

/** The Nigerian bank list for the payout-account picker. */
export async function GET() {
  try {
    const banks = await listBanks();
    if (!banks.ok) return NextResponse.json({ banks: [], error: banks.message });
    const sorted = (banks.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ banks: sorted });
  } catch {
    // No provider configured is not fatal — the player can still type a bank.
    return NextResponse.json({ banks: [] });
  }
}

/**
 * Save a payout account.
 *
 * We TRY to confirm the account name with the bank, but we do not require it.
 *
 * Flutterwave TEST keys only resolve their own sandbox account (0690000031);
 * every real Nigerian account number comes back "invalid account". Requiring
 * verification therefore made it impossible for any real player to save their
 * bank details at all — which is the bug that was reported.
 *
 * So: if the provider confirms the name, we store the CONFIRMED name and mark
 * the account verified. If it cannot, we store the name the player typed and
 * mark it unverified, and the operator gets a visible warning at payout time.
 * In manual payout mode that is a real check rather than a downgrade — a bank
 * transfer shows the true account name before the operator confirms it.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  let body: { bankCode?: unknown; bankName?: unknown; accountNumber?: unknown; accountName?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed request.' }, { status: 400 }); }

  const bankCode = String(body.bankCode ?? '').trim();
  const bankName = String(body.bankName ?? '').trim();
  const accountNumber = String(body.accountNumber ?? '').trim();
  const typedName = String(body.accountName ?? '').trim();

  if (!/^[0-9]{10}$/.test(accountNumber)) {
    return NextResponse.json({ error: 'Account numbers are 10 digits.' }, { status: 400 });
  }
  if (!bankCode) return NextResponse.json({ error: 'Choose a bank.' }, { status: 400 });

  let confirmedName: string | null = null;
  try {
    const resolved = await resolveAccount(accountNumber, bankCode);
    if (resolved.ok && resolved.data?.account_name) confirmedName = resolved.data.account_name;
  } catch {
    // Provider unavailable or unconfigured — fall through to the typed name.
  }

  const accountName = confirmedName ?? typedName;
  if (!accountName) {
    return NextResponse.json(
      { error: "We couldn't confirm that account with the bank, so please type the account holder's name." },
      { status: 400, headers: { 'x-needs-name': '1' } },
    );
  }

  const { data, error } = await supabase.rpc('save_bank_account', {
    p_bank_code: bankCode,
    p_bank_name: bankName,
    p_account_number: accountNumber,
    p_account_name: accountName,
    p_verified: confirmedName !== null,
  });

  if (error) {
    return NextResponse.json({ error: error.message.replace(/^.*?:\s*/, '') }, { status: 400 });
  }

  return NextResponse.json({
    account: Array.isArray(data) ? data[0] : data,
    verified: confirmedName !== null,
    accountName,
  });
}
