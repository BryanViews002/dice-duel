import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createPaymentLink } from '@/lib/flutterwave';

export const dynamic = 'force-dynamic';

/**
 * Start a deposit. Creates the pending row FIRST, so the reference exists in
 * our database before Flutterwave ever sees it — otherwise a successful payment
 * could arrive by webhook against a reference we have no record of.
 *
 * Nothing is credited here. Credit happens only after the webhook (or the
 * return page) verifies the charge against Flutterwave's API.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  let body: { amountKobo?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed request.' }, { status: 400 }); }

  const amountKobo = Number(body.amountKobo);
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    return NextResponse.json({ error: 'Enter a valid amount.' }, { status: 400 });
  }

  const reference = `dd-dep-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

  const { error: createErr } = await supabase.rpc('create_deposit', {
    p_amount_kobo: amountKobo,
    p_reference: reference,
  });
  if (createErr) {
    return NextResponse.json({ error: createErr.message.replace(/^.*?:\s*/, '') }, { status: 400 });
  }

  const { data: profile } = await supabase
    .from('profiles').select('username').eq('id', user.id).maybeSingle();

  const origin = request.nextUrl.origin;
  const link = await createPaymentLink({
    reference,
    amountKobo,
    email: user.email ?? '',
    name: profile?.username ?? 'player',
    redirectUrl: `${origin}/wallet?ref=${encodeURIComponent(reference)}`,
  });

  if (!link.ok || !link.data?.link) {
    return NextResponse.json(
      { error: link.message || 'Could not start the payment.' },
      { status: 502 },
    );
  }

  return NextResponse.json({ reference, link: link.data.link });
}
