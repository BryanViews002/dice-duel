import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AdminPayouts } from '@/components/AdminPayouts';

export const metadata = { title: 'Payouts · Dice Duel' };
export const dynamic = 'force-dynamic';

export default async function AdminPayoutsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const { data: profile } = await supabase
    .from('profiles').select('is_admin').eq('id', user.id).maybeSingle();

  // Checked here for a clean 404-ish experience, and AGAIN inside every
  // admin_* function in the database. The server-side check is convenience;
  // the database check is the one that actually protects payouts.
  if (!profile?.is_admin) {
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="display text-[28px]">Not an operator</h1>
        <p className="mt-3 text-[14px] text-ivory-dim/60">
          This page is for accounts that settle payouts.
        </p>
      </div>
    );
  }

  return <AdminPayouts />;
}
