import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Wallet } from '@/components/Wallet';
import type { BankAccount, Deposit, PlatformSettings, Withdrawal } from '@/lib/types';

export const metadata = { title: 'Wallet · Dice Duel' };
export const dynamic = 'force-dynamic';

export default async function WalletPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/');

  // All of these are own-row-only under RLS, so the player's own session is
  // enough — no service key needed to read a wallet.
  const [profile, accounts, withdrawals, deposits, settings, withdrawable] = await Promise.all([
    supabase.from('profiles').select('balance_kobo, wagering_required_kobo').eq('id', user.id).maybeSingle(),
    supabase.from('bank_accounts').select('*').eq('player_id', user.id).order('created_at'),
    supabase.from('withdrawals').select('*').eq('player_id', user.id).order('requested_at', { ascending: false }).limit(25),
    supabase.from('deposits').select('*').eq('player_id', user.id).order('created_at', { ascending: false }).limit(25),
    supabase.from('platform_settings').select('*').maybeSingle(),
    supabase.rpc('withdrawable_kobo', { p_player: user.id }),
  ]);

  if (!profile.data || !settings.data) {
    return (
      <div className="mx-auto max-w-md px-6 py-20 text-center">
        <h1 className="display text-[26px]">Wallet unavailable</h1>
        <p className="mt-3 text-[14px] text-ivory-dim/65">
          The payments migrations have not been applied to this project yet. Run
          <code className="mx-1 rounded bg-felt-900 px-1.5 py-0.5 font-mono text-xs">0006_naira.sql</code>
          and
          <code className="mx-1 rounded bg-felt-900 px-1.5 py-0.5 font-mono text-xs">0007_payments.sql</code>.
        </p>
      </div>
    );
  }

  return (
    <Wallet
      balanceKobo={profile.data.balance_kobo}
      wageringRequiredKobo={profile.data.wagering_required_kobo ?? 0}
      withdrawableKobo={Number(withdrawable.data ?? 0)}
      accounts={(accounts.data ?? []) as BankAccount[]}
      withdrawals={(withdrawals.data ?? []) as Withdrawal[]}
      deposits={(deposits.data ?? []) as Deposit[]}
      settings={settings.data as PlatformSettings}
    />
  );
}
