'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { verifyProof, type Proof, type VerifyReport } from '@/lib/game';
import { Die3D } from './Die3D';

export function Verifier({ initialMatchId }: { initialMatchId: string | null }) {
  const [matchId, setMatchId] = useState(initialMatchId ?? '');
  const [proof, setProof] = useState<Proof | null>(null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    setReport(null);
    setProof(null);

    const supabase = createClient();
    const { data: m } = await supabase
      .from('matches')
      .select('server_seed_hash, revealed_server_seed, client_seed_a, client_seed_b, status')
      .eq('id', id.trim())
      .maybeSingle();

    if (!m) {
      setError('No match with that id. Finished matches are public; live ones are not.');
      setBusy(false);
      return;
    }
    if (!m.revealed_server_seed) {
      setError('That match has not finished yet, so its seed is still sealed.');
      setBusy(false);
      return;
    }

    const { data: rs } = await supabase
      .from('match_rounds')
      .select('round_no, dice_a, dice_b, result')
      .eq('match_id', id.trim())
      .order('round_no');

    const p: Proof = {
      server_seed_hash: m.server_seed_hash,
      revealed_server_seed: m.revealed_server_seed,
      client_seed_a: m.client_seed_a,
      client_seed_b: m.client_seed_b ?? '',
      rounds: (rs ?? []) as Proof['rounds'],
    };

    setProof(p);
    setReport(await verifyProof(p));
    setBusy(false);
  }, []);

  useEffect(() => {
    if (initialMatchId) void load(initialMatchId);
  }, [initialMatchId, load]);

  return (
    <div className="space-y-5">
      <div className="surface p-6">
        <label className="eyebrow mb-2 block" htmlFor="mid">
          Match id
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="mid"
            value={matchId}
            onChange={(e) => setMatchId(e.target.value)}
            placeholder="paste a match id"
            className="min-w-0 flex-1 rounded-xl border border-felt-700 bg-felt-900/80 px-3.5 py-2.5 font-mono text-sm outline-none placeholder:text-ivory/20 focus:border-brass-500"
          />
          <button
            onClick={() => void load(matchId)}
            disabled={busy || !matchId.trim()}
            className="rounded-xl bg-gradient-to-b from-brass-400 to-brass-500 px-5 py-2.5 font-semibold text-felt-950 transition hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Checking…' : 'Verify'}
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-oxblood">{error}</p>}
      </div>

      {report && proof && (
        <>
          <div
            className={`surface border-2 p-6 ${
              report.ok ? 'border-jade/50 bg-jade/5' : 'border-oxblood/50 bg-oxblood/5'
            }`}
          >
            <div className={`text-lg font-bold ${report.ok ? 'text-jade' : 'text-oxblood'}`}>
              {report.ok ? '✓ Verified' : '✗ Verification failed'}
            </div>
            <p className="mt-1 text-sm text-ivory/60">{report.reason}</p>

            <div className="mt-4 space-y-1.5 text-xs">
              <Check ok={report.commitmentOk}>
                sha256(revealed seed) matches the hash published before the match started
              </Check>
              <Check ok={report.steps.every((s) => s.diceMatch)}>
                Every die recomputes from the seed pair in your own browser
              </Check>
              <Check ok={report.steps.every((s) => s.resultMatch)}>
                Every round was scored by the stated rules
              </Check>
            </div>
          </div>

          <div className="surface overflow-hidden">
            <div className="border-b border-felt-700/60 px-5 py-2.5">
              <span className="eyebrow">Recomputed rounds</span>
            </div>
            <div className="divide-y divide-felt-850/70">
              {report.steps.map((s) => (
                <div key={s.round} className="flex flex-wrap items-center gap-4 px-5 py-3">
                  <span className="tabular w-8 text-sm text-ivory/35">#{s.round}</span>

                  <div className="flex items-center gap-2">
                    <span className="eyebrow w-14">Seat A</span>
                    {s.expectedA.map((d, i) => (
                      <Die3D key={i} value={d} size="sm" delay={i * 80} />
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="eyebrow w-14">Seat B</span>
                    {s.expectedB.map((d, i) => (
                      <Die3D key={i} value={d} size="sm" delay={i * 80} />
                    ))}
                  </div>

                  <span
                    className={`ml-auto text-xs ${
                      s.diceMatch && s.resultMatch ? 'text-jade' : 'text-oxblood'
                    }`}
                  >
                    {s.diceMatch && s.resultMatch ? 'matches what was played' : 'MISMATCH'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <details className="surface px-5 py-3 [&_summary]:cursor-pointer">
            <summary className="eyebrow">Raw proof</summary>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-felt-950/60 p-3 font-mono text-[11px] text-ivory/55">
              {JSON.stringify(proof, null, 2)}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex items-start gap-2 ${ok ? 'text-ivory/65' : 'text-oxblood'}`}>
      <span className={ok ? 'text-jade' : 'text-oxblood'}>{ok ? '✓' : '✗'}</span>
      <span>{children}</span>
    </div>
  );
}
