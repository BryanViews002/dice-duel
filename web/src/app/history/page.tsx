import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { money, signedMoney, timeAgo } from '@/lib/format';
import type { Match, PublicProfile } from '@/lib/types';

export const metadata = { title: 'History · Dice Duel' };
export const revalidate = 0;

export default async function HistoryPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const { data } = await supabase
    .from('matches')
    .select('*')
    .in('status', ['finished', 'void'])
    .or(`player_a.eq.${user.id},player_b.eq.${user.id}`)
    .order('finished_at', { ascending: false })
    .limit(60);

  const matches = (data ?? []) as Match[];

  // Resolve opponent names in one round trip.
  const opponentIds = [
    ...new Set(matches.map((m) => (m.player_a === user.id ? m.player_b : m.player_a)).filter(Boolean)),
  ] as string[];

  const { data: people } = opponentIds.length
    ? await supabase.from('public_profiles').select('*').in('id', opponentIds)
    : { data: [] };

  const byId = new Map((people ?? []).map((p) => [(p as PublicProfile).id, p as PublicProfile]));

  const settled = matches.filter((m) => m.status === 'finished' && m.winner);
  const wins = settled.filter((m) => (m.winner === 'a' ? m.player_a : m.player_b) === user.id).length;
  const profit = settled.reduce((sum, m) => {
    const won = (m.winner === 'a' ? m.player_a : m.player_b) === user.id;
    return sum + (won ? (m.payout_kobo ?? 0) - m.stake_kobo : -m.stake_kobo);
  }, 0);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="display text-[30px] sm:text-[42px]">Your matches</h1>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {[
          { k: 'Played', v: String(settled.length) },
          { k: 'Won', v: `${wins}${settled.length ? ` · ${Math.round((wins / settled.length) * 100)}%` : ''}` },
          { k: 'Net', v: signedMoney(profit), tone: profit >= 0 ? 'text-jade' : 'text-oxblood' },
        ].map((s) => (
          <div key={s.k} className="surface p-5">
            <div className="eyebrow">{s.k}</div>
            <div className={`tabular mt-1 text-2xl font-bold ${s.tone ?? ''}`}>{s.v}</div>
          </div>
        ))}
      </div>

      {matches.length === 0 ? (
        <p className="surface mt-6 p-10 text-center text-ivory/40">
          Nothing here yet.{' '}
          <Link href="/play" className="text-brass-400 hover:underline">
            Go play a hand.
          </Link>
        </p>
      ) : (
        <div className="surface mt-6 divide-y divide-felt-850/70">
          {matches.map((m) => {
            const otherId = m.player_a === user.id ? m.player_b : m.player_a;
            const other = otherId ? byId.get(otherId) : null;
            const mySeat = m.player_a === user.id ? 'a' : 'b';
            const won = m.status === 'finished' && m.winner === mySeat;
            const delta = m.status === 'void'
              ? 0
              : won
                ? (m.payout_kobo ?? 0) - m.stake_kobo
                : -m.stake_kobo;

            return (
              <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    vs {other?.username ?? 'unknown'}
                    {m.is_private && (
                      <span className="ml-2 rounded border border-felt-600 px-1.5 py-0.5 text-[10px] text-ivory/40">
                        PRIVATE
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-ivory/40">
                    {money(m.stake_kobo)} stake · {m.round} round{m.round === 1 ? '' : 's'} ·{' '}
                    {m.finished_at ? timeAgo(m.finished_at) : ''}
                  </div>
                </div>

                <div
                  className={`tabular text-right font-semibold ${
                    m.status === 'void' ? 'text-ivory/40' : won ? 'text-jade' : 'text-oxblood'
                  }`}
                >
                  {m.status === 'void' ? 'refunded' : signedMoney(delta)}
                </div>

                {m.revealed_server_seed && (
                  <Link
                    href={{ pathname: '/verify', query: { match: m.id } }}
                    className="rounded-lg border border-felt-700 px-2.5 py-1.5 text-xs text-ivory/50 transition hover:border-brass-500 hover:text-brass-400"
                  >
                    Verify
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
