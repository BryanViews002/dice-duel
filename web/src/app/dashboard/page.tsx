import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Dashboard } from '@/components/Dashboard';

export const metadata = { title: 'Dashboard · Dice Duel' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const [{ data: profile }, { data: stats }] = await Promise.all([
    supabase.from('profiles')
      .select('id, username, avatar_seed, balance_kobo, wagering_required_kobo')
      .eq('id', user.id).maybeSingle(),
    supabase.from('player_stats')
      .select('played, wins, losses, win_pct, profit_kobo')
      .eq('id', user.id).maybeSingle(),
  ]);

  if (!profile) redirect('/play');

  return <Dashboard me={profile} stats={stats ?? null} />;
}
