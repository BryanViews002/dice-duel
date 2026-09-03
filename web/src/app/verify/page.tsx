import { Verifier } from '@/components/Verifier';

export const metadata = { title: 'Verify · Dice Duel' };

export default async function VerifyPage({ searchParams }: PageProps<'/verify'>) {
  const params = await searchParams;
  const matchId = typeof params.match === 'string' ? params.match : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="display text-[42px]">Verify a match</h1>
      <p className="mt-2.5 max-w-2xl text-[14px] leading-relaxed text-ivory-dim/70">
        Every match is sealed before it starts: the server picks a secret seed, publishes
        only its SHA-256 hash, and reveals the seed when the match ends. Both players also
        contribute a seed of their own. Paste a finished match id and this page will
        recompute every die <em>in your browser</em> — nothing here trusts the server&apos;s
        word for the result.
      </p>

      <div className="mt-8">
        <Verifier initialMatchId={matchId} />
      </div>

      <div className="surface mt-8 p-6 text-sm text-ivory/55">
        <div className="eyebrow mb-3">How the dice are derived</div>
        <pre className="overflow-x-auto rounded-lg bg-felt-950/60 p-4 font-mono text-[11px] leading-relaxed text-ivory/70">
{`bytes = HMAC_SHA256(
    key = revealed_server_seed,
    msg = "<clientSeedA>:<clientSeedB>:<round>:<seat>:<counter>"
)

for each byte:
    if byte >= 252: skip        # keeps every face exactly 1/6
    die = (byte % 6) + 1
    stop once two dice are drawn`}
        </pre>
        <p className="mt-4">
          The <code className="rounded bg-felt-900 px-1 py-0.5 font-mono text-xs">byte &gt;= 252</code>{' '}
          rejection matters: 256 is not divisible by 6, so folding every byte with{' '}
          <code className="rounded bg-felt-900 px-1 py-0.5 font-mono text-xs">% 6</code> would make
          faces 1–4 very slightly likelier than 5–6. Discarding the last four values of the
          byte range removes that bias completely.
        </p>
      </div>
    </div>
  );
}
