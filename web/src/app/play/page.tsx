import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { PlayClient } from '@/components/PlayClient';

export const metadata = { title: 'Play · Dice Duel' };

export default async function PlayPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, username, avatar_seed, balance_kobo')
    .eq('id', user.id)
    .maybeSingle();

  // The profile is created by the handle_new_user() trigger. If it is missing
  // the migration has not been applied to this project yet.
  if (!profile) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="text-xl font-semibold">No profile found</h1>
        <p className="mt-2 text-sm text-ivory/55">
          Your account exists but has no player profile. Apply
          <code className="mx-1 rounded bg-felt-900 px-1.5 py-0.5 font-mono text-xs">
            supabase/migrations/0001_init.sql
          </code>
          to your project, then sign up again.
        </p>
      </div>
    );
  }

  return <PlayClient me={profile} />;
}
