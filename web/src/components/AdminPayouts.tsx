'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createClient } from '@/lib/supabase/client';
import { money, timeAgo } from '@/lib/format';

type Pending = {
  reference: string;
  status: string;
  username: string;
  amount_kobo: number;
  fee_kobo: number;
  net_kobo: number;
  account_name: string;
  bank_name: string;
  bank_code: string;
  account_number: string;
  is_verified: boolean;
  requested_at: string;
};

type Recent = {
  reference: string;
  status: string;
  username: string;
  net_kobo: number;
  manual_reference: string | null;
  settled_at: string | null;
};

export function AdminPayouts() {
  const supabase = createClient();
  const [pending, setPending] = useState<Pending[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([
      supabase.rpc('admin_pending_payouts'),
      supabase.rpc('admin_recent_payouts', { p_limit: 15 }),
    ]);
    if (p.error) setError(p.error.message);
    else setPending((p.data ?? []) as Pending[]);
    setRecent((r.data ?? []) as Recent[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
    // A payout can arrive at any moment; keep the queue current without a reload.
    const channel = supabase
      .channel('admin-payouts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'withdrawals' }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [supabase, load]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-[30px] sm:text-[42px]">Payouts</h1>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ivory-dim/70">
            Send each transfer from your bank, then record it here. The player&apos;s
            funds were already reserved when they requested it — marking a payout
            paid settles the record, it does not move money.
          </p>
        </div>
        <span className="rounded-full border border-brass-500/40 bg-brass-500/10 px-3 py-1 text-[11px] font-medium tracking-wide text-brass-300">
          MANUAL MODE
        </span>
      </div>

      {error && (
        <p className="mt-6 rounded-lg border border-oxblood/35 bg-oxblood/10 px-4 py-3 text-[13px] text-oxblood">
          {error}
        </p>
      )}

      <div className="mt-8">
        <div className="eyebrow mb-3">
          Waiting {pending.length > 0 && `· ${pending.length}`}
        </div>

        {loading ? (
          <div className="surface p-10 text-center text-[14px] text-ivory-dim/40">Loading…</div>
        ) : pending.length === 0 ? (
          <div className="surface p-10 text-center text-[14px] text-ivory-dim/45">
            Nothing waiting. Payouts appear here the moment a player requests one.
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence initial={false}>
              {pending.map((p) => (
                <PayoutCard
                  key={p.reference}
                  payout={p}
                  busy={busy === p.reference}
                  onSettle={async (outcome, bankRef, note) => {
                    setBusy(p.reference);
                    setError(null);
                    const { error } = await supabase.rpc('admin_settle_payout', {
                      p_reference: p.reference,
                      p_outcome: outcome,
                      p_bank_reference: bankRef,
                      p_note: note,
                    });
                    if (error) setError(error.message.replace(/^.*?:\s*/, ''));
                    setBusy(null);
                    await load();
                  }}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <div className="mt-12">
          <div className="eyebrow mb-3">Recently settled</div>
          <div className="surface divide-y divide-felt-850/70 overflow-hidden">
            {recent.map((r) => (
              <div key={r.reference} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                <span className="min-w-[110px] flex-1 truncate text-[14px]">{r.username}</span>
                <span className="tabular text-[13px] text-ivory-dim/70">{money(r.net_kobo)}</span>
                {r.manual_reference && (
                  <span className="font-mono text-[11px] text-ivory-dim/40">
                    {r.manual_reference}
                  </span>
                )}
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                    r.status === 'paid'
                      ? 'border-jade/40 text-jade'
                      : 'border-oxblood/40 text-oxblood'
                  }`}
                >
                  {r.status}
                </span>
                <span className="w-20 text-right text-[11px] text-ivory-dim/35">
                  {r.settled_at ? timeAgo(r.settled_at) : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PayoutCard({
  payout, busy, onSettle,
}: {
  payout: Pending;
  busy: boolean;
  onSettle: (outcome: 'paid' | 'failed', bankRef: string, note: string) => Promise<void>;
}) {
  const [bankRef, setBankRef] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<null | 'paid' | 'failed'>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (label: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1400);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      className="surface p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <div className="eyebrow mb-1.5">Send exactly</div>
          <div className="money text-[26px] sm:text-[34px] font-semibold leading-none">{money(payout.net_kobo)}</div>
          <div className="mt-2 text-[12px] text-ivory-dim/50">
            {money(payout.amount_kobo)} requested less {money(payout.fee_kobo)} fee
          </div>
        </div>

        <div className="text-right">
          <div className="eyebrow mb-1.5">To</div>
          <div className="text-[15px] font-medium">
            {payout.account_name}
            {!payout.is_verified && (
              <span className="ml-2 rounded border border-brass-500/50 px-1.5 py-0.5 text-[10px] font-normal tracking-wide text-brass-300">
                UNCONFIRMED
              </span>
            )}
          </div>
          <div className="mt-1 text-[13px] text-ivory-dim/70">{payout.bank_name}</div>
          <button
            onClick={() => copy('account', payout.account_number)}
            className="tabular mt-1 font-mono text-[15px] tracking-wide text-brass-300 transition hover:text-brass-200"
            title="Copy account number"
          >
            {payout.account_number}
            <span className="ml-2 text-[10px] text-ivory-dim/40">
              {copied === 'account' ? 'copied' : 'copy'}
            </span>
          </button>
        </div>
      </div>

      {!payout.is_verified && (
        <p className="mt-4 rounded-lg border border-brass-500/30 bg-brass-500/[0.07] px-4 py-2.5 text-[12.5px] leading-relaxed text-brass-200/90">
          This account name was typed by the player, not confirmed by the bank.
          Check the name your banking app shows before you confirm the transfer —
          a transfer to the wrong account cannot be recovered.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-felt-800 pt-4 text-[12px] text-ivory-dim/50">
        <span>{payout.username}</span>
        <span>requested {timeAgo(payout.requested_at)}</span>
        <span className="font-mono text-[11px]">{payout.reference}</span>
      </div>

      {/* ---- record the outcome ---- */}
      <div className="mt-5 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input
          value={bankRef}
          onChange={(e) => { setBankRef(e.target.value); setConfirming(null); }}
          placeholder="Bank receipt / session reference"
          className="w-full rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2.5 font-mono text-[13px] outline-none transition-colors placeholder:text-ivory-dim/25 focus:border-brass-500/70"
        />
        <button
          onClick={() => (confirming === 'paid' ? onSettle('paid', bankRef, note) : setConfirming('paid'))}
          disabled={busy || !bankRef.trim()}
          className={
            confirming === 'paid'
              ? 'rounded-[10px] bg-jade px-5 py-2.5 text-[14px] font-semibold text-felt-950'
              : 'btn-brass hover:btn-brass-hover px-5 py-2.5 text-[14px] disabled:opacity-35'
          }
        >
          {busy ? 'Saving…' : confirming === 'paid' ? `Confirm ${money(payout.net_kobo)} sent` : 'Mark paid'}
        </button>
        <button
          onClick={() => (confirming === 'failed' ? onSettle('failed', bankRef, note || 'transfer did not go through') : setConfirming('failed'))}
          disabled={busy}
          className={
            confirming === 'failed'
              ? 'rounded-[10px] bg-oxblood px-4 py-2.5 text-[13px] font-semibold text-ivory'
              : 'btn-ghost px-4 py-2.5 text-[13px] hover:border-oxblood/50 hover:text-oxblood'
          }
        >
          {confirming === 'failed' ? 'Confirm refund' : 'Mark failed'}
        </button>
      </div>

      {!bankRef.trim() && (
        <p className="mt-2 text-[11.5px] text-ivory-dim/40">
          The receipt reference is required before a payout can be marked paid — so
          you are reading it off the transfer, not from memory.
        </p>
      )}

      <AnimatePresence>
        {confirming && (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className={`mt-3 overflow-hidden text-[13px] ${
              confirming === 'paid' ? 'text-jade' : 'text-oxblood'
            }`}
          >
            {confirming === 'paid'
              ? `Confirm you have sent ${money(payout.net_kobo)} to ${payout.account_name} · ${payout.account_number}. Click again to record it.`
              : `This returns ${money(payout.amount_kobo)} to ${payout.username}'s balance. Click again to confirm.`}
          </motion.p>
        )}
      </AnimatePresence>

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="mt-2 w-full rounded-lg border border-felt-800 bg-felt-950/40 px-3.5 py-2 text-[12.5px] outline-none placeholder:text-ivory-dim/20 focus:border-felt-600"
      />
    </motion.div>
  );
}
