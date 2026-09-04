'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { money, nairaInputToKobo } from '@/lib/format';

type Controls = {
  deposit_limit_kobo: number | null;
  pending_limit_kobo: number | null;
  pending_effective_at: string | null;
  deposited_last_24h_kobo: number;
  withdrawn_last_24h_kobo: number;
  daily_withdrawal_limit_kobo: number;
  self_excluded_until: string | null;
};

const EXCLUSION_PERIODS = [
  { days: 1, label: '24 hours' },
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
  { days: 182, label: '6 months' },
  { days: 365, label: '1 year' },
] as const;

export function PlayControls() {
  const supabase = createClient();
  const router = useRouter();
  const [c, setC] = useState<Controls | null>(null);
  const [limitInput, setLimitInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmExclude, setConfirmExclude] = useState<number | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc('my_play_controls');
    const row = Array.isArray(data) ? data[0] : data;
    if (row) setC(row as Controls);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  if (!c) return <div className="surface p-8 text-center text-[14px] text-ivory-dim/40">Loading…</div>;

  const excluded = c.self_excluded_until && new Date(c.self_excluded_until) > new Date();

  async function setLimit(kobo: number | null) {
    setBusy(true); setError(null); setNotice(null);
    const { data, error } = await supabase.rpc('set_deposit_limit', { p_kobo: kobo });
    if (error) setError(error.message.replace(/^.*?:\s*/, ''));
    else setNotice(data === 'applied'
      ? 'Limit applied straight away.'
      : 'Because this raises your limit, it takes effect in 24 hours. Your current limit stays in force until then.');
    setBusy(false);
    setLimitInput('');
    await load();
  }

  async function exclude(days: number) {
    setBusy(true); setError(null);
    const { error } = await supabase.rpc('self_exclude', { p_days: days });
    if (error) setError(error.message.replace(/^.*?:\s*/, ''));
    setBusy(false);
    setConfirmExclude(null);
    await load();
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {excluded && (
        <div className="surface border-oxblood/40 bg-oxblood/[0.06] p-6">
          <div className="text-[15px] font-medium text-oxblood">You are self-excluded</div>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ivory-dim/80">
            You cannot deposit or play until{' '}
            <strong>{new Date(c.self_excluded_until!).toLocaleDateString('en-NG', {
              day: 'numeric', month: 'long', year: 'numeric',
            })}</strong>. This cannot be shortened — not by you, and not by us. That is
            the point of it.
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-ivory-dim/60">
            You can still withdraw any balance you hold. If gambling is causing you
            harm, please talk to someone — details are at the bottom of every page.
          </p>
        </div>
      )}

      {/* -------------------------------------------------- deposit limit */}
      <div className="surface p-6">
        <div className="eyebrow mb-1">Your daily deposit limit</div>
        <p className="mb-5 text-[13px] leading-relaxed text-ivory-dim/65">
          Cap how much you can add in any 24 hours. Lowering it works immediately.
          Raising or removing it takes 24 hours — so the decision is never made in
          the heat of the moment.
        </p>

        <dl className="mb-5 space-y-2 rounded-lg border border-felt-800 bg-felt-950/40 px-4 py-3.5 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-ivory-dim/60">Current limit</dt>
            <dd className="tabular">
              {c.deposit_limit_kobo === null ? 'None set' : money(c.deposit_limit_kobo)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ivory-dim/60">Deposited in the last 24h</dt>
            <dd className="tabular">{money(c.deposited_last_24h_kobo)}</dd>
          </div>
        </dl>

        {c.pending_limit_kobo !== null && c.pending_effective_at && (
          <p className="mb-4 rounded-lg border border-brass-500/30 bg-brass-500/[0.07] px-4 py-2.5 text-[12.5px] text-brass-200/90">
            A change to {c.pending_limit_kobo === null ? 'no limit' : money(c.pending_limit_kobo)} takes
            effect {new Date(c.pending_effective_at).toLocaleString('en-NG')}.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[180px] flex-1">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ivory-dim/45">₦</span>
            <input
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              inputMode="decimal"
              placeholder="e.g. 20,000"
              className="tabular w-full rounded-lg border border-felt-700 bg-felt-950/60 py-2.5 pl-8 pr-3.5 text-[15px] outline-none focus:border-brass-500/70"
            />
          </div>
          <button
            onClick={() => { const k = nairaInputToKobo(limitInput); if (k) void setLimit(k); }}
            disabled={busy || !nairaInputToKobo(limitInput)}
            className="btn-brass hover:btn-brass-hover px-5 text-[14px] disabled:opacity-40"
          >
            Set limit
          </button>
          {c.deposit_limit_kobo !== null && (
            <button
              onClick={() => void setLimit(null)}
              disabled={busy}
              className="btn-ghost px-4 text-[13px] hover:border-brass-500/60 hover:text-ivory"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* -------------------------------------------------- house limits */}
      <div className="surface p-6">
        <div className="eyebrow mb-4">Table limits</div>
        <dl className="space-y-2.5 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-ivory-dim/60">Withdrawn in the last 24h</dt>
            <dd className="tabular">
              {money(c.withdrawn_last_24h_kobo)} of {money(c.daily_withdrawal_limit_kobo)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ivory-dim/60">Per deposit</dt>
            <dd className="tabular text-ivory-dim/80">₦2,000 – ₦1,000,000</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ivory-dim/60">Per withdrawal</dt>
            <dd className="tabular text-ivory-dim/80">₦2,000 – ₦1,000,000</dd>
          </div>
        </dl>
      </div>

      {/* -------------------------------------------------- self-exclusion */}
      {!excluded && (
        <div className="surface p-6">
          <div className="eyebrow mb-1">Take a break</div>
          <p className="mb-5 text-[13px] leading-relaxed text-ivory-dim/65">
            Lock yourself out of depositing and playing. You can still withdraw what
            you hold. <strong className="text-ivory-dim/85">This cannot be undone
            early</strong> — once set, it runs its full course.
          </p>

          <div className="flex flex-wrap gap-2">
            {EXCLUSION_PERIODS.map((p) => (
              <button
                key={p.days}
                onClick={() => setConfirmExclude(p.days)}
                disabled={busy}
                className={`rounded-lg border px-4 py-2 text-[13px] transition ${
                  confirmExclude === p.days
                    ? 'border-oxblood bg-oxblood text-ivory'
                    : 'border-felt-700 text-ivory-dim/75 hover:border-oxblood/50 hover:text-oxblood'
                }`}
              >
                {confirmExclude === p.days ? 'Tap again to confirm' : p.label}
              </button>
            ))}
          </div>

          {confirmExclude !== null && (
            <div className="mt-4">
              <p className="mb-3 text-[13px] text-oxblood">
                This will lock your account for{' '}
                {EXCLUSION_PERIODS.find((p) => p.days === confirmExclude)?.label}. It
                cannot be reversed.
              </p>
              <button
                onClick={() => void exclude(confirmExclude)}
                disabled={busy}
                className="rounded-lg bg-oxblood px-5 py-2.5 text-[14px] font-semibold text-ivory"
              >
                {busy ? 'Applying…' : 'Yes, exclude me'}
              </button>
              <button
                onClick={() => setConfirmExclude(null)}
                className="ml-3 px-3 py-2.5 text-[13px] text-ivory-dim/50 hover:text-ivory"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-[13px] text-oxblood">{error}</p>}
      {notice && <p className="text-[13px] text-jade">{notice}</p>}
    </div>
  );
}
