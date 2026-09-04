import { createClient } from '@/lib/supabase/server';
import { Avatar } from '@/components/Avatar';
import { money, signedMoney } from '@/lib/format';
import type { PlayerStats } from '@/lib/types';

export const metadata = { title: 'Leaderboard · Dice Duel' };
export const revalidate = 0;

export default async function LeaderboardPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from('player_stats')
    .select('*')
    .gt('played', 0)
    .order('profit_kobo', { ascending: false })
    .limit(50);

  const rows = (data ?? []) as PlayerStats[];

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="display text-[30px] sm:text-[42px]">Standings</h1>
      <p className="mt-2.5 max-w-xl text-[14px] leading-relaxed text-ivory-dim/70">
        Ranked by lifetime profit. The game is a coin flip, so anyone near the top
        has mostly been lucky — that is the point.
      </p>

      {rows.length === 0 ? (
        <p className="surface mt-8 p-10 text-center text-ivory/40">
          No finished matches yet. Be the first.
        </p>
      ) : (
        <div className="surface mt-8 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="eyebrow border-b border-felt-700">
                <th className="px-5 py-3 text-left font-normal">#</th>
                <th className="px-3 py-3 text-left font-normal">Player</th>
                <th className="px-3 py-3 text-right font-normal">Played</th>
                <th className="px-3 py-3 text-right font-normal">Won</th>
                <th className="px-3 py-3 text-right font-normal">Win %</th>
                <th className="px-3 py-3 text-right font-normal">Biggest pot</th>
                <th className="px-5 py-3 text-right font-normal">Profit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className="border-b border-felt-850/70 last:border-0">
                  <td className="tabular px-5 py-3 text-ivory/35">{i + 1}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar seed={r.avatar_seed} name={r.username} size={30} />
                      <span className="font-medium">{r.username}</span>
                    </div>
                  </td>
                  <td className="tabular px-3 py-3 text-right text-ivory/60">{r.played}</td>
                  <td className="tabular px-3 py-3 text-right text-ivory/60">{r.wins}</td>
                  <td className="tabular px-3 py-3 text-right text-ivory/60">{r.win_pct}%</td>
                  <td className="tabular px-3 py-3 text-right text-ivory/60">
                    {money(r.biggest_pot_kobo)}
                  </td>
                  <td
                    className={`tabular px-5 py-3 text-right font-semibold ${
                      r.profit_kobo >= 0 ? 'text-jade' : 'text-oxblood'
                    }`}
                  >
                    {signedMoney(r.profit_kobo)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
