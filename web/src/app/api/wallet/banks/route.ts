import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { listBanks, resolveAccount } from '@/lib/flutterwave';

export const dynamic = 'force-dynamic';

/** The Nigerian bank list, for the payout-account picker. */
export async function GET() {
  const banks = await listBanks();
  if (!banks.ok) {
    return NextResponse.json({ error: banks.message }, { status: 502 });
  }
  const sorted = (banks.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ banks: sorted });
}

/**
 * Add a payout account.
 *
 * The account name is RESOLVED with Flutterwave, never typed by the user. A
 * transfer to a wrong-but-valid account number succeeds and the money is gone
 * to a stranger with no recourse, so showing the real account holder's name
 * before the first payout is the only guard that matters here.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  let body: { bankCode?: unknown; bankName?: unknown; accountNumber?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed request.' }, { status: 400 }); }

  const bankCode = String(body.bankCode ?? '').trim();
  const bankName = String(body.bankName ?? '').trim();
  const accountNumber = String(body.accountNumber ?? '').trim();

  if (!/^[0-9]{10}$/.test(accountNumber)) {
    return NextResponse.json({ error: 'Account numbers are 10 digits.' }, { status: 400 });
  }
  if (!bankCode) return NextResponse.json({ error: 'Choose a bank.' }, { status: 400 });

  const resolved = await resolveAccount(accountNumber, bankCode);
  if (!resolved.ok || !resolved.data?.account_name) {
    return NextResponse.json(
      { error: resolved.message || 'Could not verify that account. Check the number and bank.' },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('bank_accounts')
    .upsert(
      {
        player_id: user.id,
        bank_code: bankCode,
        bank_name: bankName,
        account_number: accountNumber,
        account_name: resolved.data.account_name,
      },
      { onConflict: 'player_id,bank_code,account_number' },
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ account: data });
}
