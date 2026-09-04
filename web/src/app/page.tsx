import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AuthPanel } from '@/components/AuthPanel';
import { Die3D } from '@/components/Die3D';
import { TableBackground } from '@/components/TableBackground';

const RULES = [
  { a: [6, 2], b: [3, 4], verdict: 'One six takes it', tone: 'win' },
  { a: [6, 6], b: [6, 3], verdict: 'Double six outranks a single', tone: 'win' },
  { a: [6, 1], b: [6, 5], verdict: 'Level on sixes — roll again', tone: 'tie' },
] as const;

export default async function Home({ searchParams }: PageProps<'/'>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : '/dashboard';

  if (user) redirect('/dashboard');

  return (
    <>
      <TableBackground intensity={0.75} />

      <div className="mx-auto max-w-6xl px-6">
        {/* masthead */}
        <div className="flex items-center justify-between border-b border-felt-800/70 py-6">
          <span className="display text-lg">Dice Duel</span>
          <Link
            href="/verify"
            className="eyebrow transition-colors hover:text-brass-400"
          >
            Verify a match
          </Link>
        </div>

        <div className="grid gap-16 py-16 lg:grid-cols-[1.1fr_400px] lg:gap-20 lg:py-24">
          {/* ------------------------------------------------ pitch */}
          <div>
            <p className="eyebrow mb-7 flex items-center gap-2.5">
              <span className="inline-block h-px w-8 bg-brass-500/70" />
              Provably fair · two dice a side
            </p>

            <h1 className="display text-[clamp(2.9rem,7vw,4.9rem)]">
              Most sixes
              <br />
              takes the pot.
            </h1>

            <p className="mt-7 max-w-md text-[17px] leading-relaxed text-ivory-dim">
              Both players post the same stake before a single die is thrown.
              Count your sixes — the higher count wins everything. Level, and you
              roll again.
            </p>

            {/* rules as evidence, not bullet points */}
            <div className="mt-14 space-y-px overflow-hidden rounded-xl border border-felt-800">
              {RULES.map((r) => (
                <div
                  key={r.verdict}
                  className="flex flex-wrap items-center gap-x-6 gap-y-4 bg-felt-900/50 px-5 py-5 sm:flex-nowrap"
                >
                  <div className="flex items-end gap-2.5">
                    {r.a.map((v, i) => <Die3D key={i} value={v} size="sm" delay={i * 90} />)}
                  </div>
                  <span className="eyebrow text-[10px]">beats</span>
                  <div className="flex items-end gap-2.5">
                    {r.b.map((v, i) => <Die3D key={i} value={v} size="sm" delay={200 + i * 90} />)}
                  </div>
                  <span
                    className={`ml-auto whitespace-nowrap text-sm ${
                      r.tone === 'tie' ? 'text-brass-400' : 'text-ivory-dim'
                    }`}
                  >
                    {r.verdict}
                  </span>
                </div>
              ))}
            </div>

            {/* facts */}
            <dl className="mt-14 grid gap-x-10 gap-y-8 sm:grid-cols-3">
              {[
                ['50 / 50', 'Neither seat holds an edge. Proven across all 1,296 dice combinations.'],
                ['Sealed first', 'The house commits to a hashed seed before you stake, and reveals it after.'],
                ['Check it yourself', 'Replay any finished match in your own browser and recompute every die.'],
              ].map(([term, desc]) => (
                <div key={term}>
                  <dt className="display mb-2 text-[22px] text-brass-300">{term}</dt>
                  <dd className="text-[13.5px] leading-relaxed text-ivory-dim/80">{desc}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* ------------------------------------------------ auth */}
          <div className="lg:pt-4">
            <AuthPanel next={next} />
            <p className="mt-5 px-1 text-center text-xs leading-relaxed text-ivory-dim/50">
              Real-money play. Fund your balance to take a seat, and withdraw your
              winnings to your bank. 18+ only — please play responsibly.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
