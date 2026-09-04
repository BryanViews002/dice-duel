'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { createClient } from '@/lib/supabase/client';
import { money, nairaInputToKobo, timeAgo, DEPOSIT_PRESETS } from '@/lib/format';
import type { BankAccount, Withdrawal, Deposit, PlatformSettings } from '@/lib/types';

type Props = {
  balanceKobo: number;
  wageringRequiredKobo: number;
  withdrawableKobo: number;
  accounts: BankAccount[];
  withdrawals: Withdrawal[];
  deposits: Deposit[];
  settings: PlatformSettings;
};

const STATUS_COPY: Record<string, { label: string; tone: 'good' | 'bad' | 'wait'; note: string }> = {
  requested: { label: 'Queued', tone: 'wait', note: 'Reserved and about to be sent to your bank.' },
  review:    { label: 'In review', tone: 'wait', note: 'Above the automatic limit — a person is checking it. Your funds are reserved.' },
  processing:{ label: 'Sending', tone: 'wait', note: 'With your bank now. Bank transfers can take a few minutes, occasionally longer.' },
  paid:      { label: 'Paid', tone: 'good', note: 'Settled into your account.' },
  failed:    { label: 'Failed', tone: 'bad', note: 'The transfer did not go through and the money is back in your balance.' },
  reversed:  { label: 'Reversed', tone: 'bad', note: 'Your bank returned this payout. The money is back in your balance.' },
};

export function Wallet(props: Props) {
  const router = useRouter();
  const supabase = createClient();

  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const live = props.withdrawals.find((w) =>
    ['requested', 'review', 'processing'].includes(w.status));

  // Deposit recovery. A dropped webhook used to mean a player paid and was
  // never credited, with nothing to notice. Asking on page load closes that:
  // the person most likely to spot an uncredited payment is the one who made
  // it, and they are already here. Safe to call repeatedly — crediting is
  // idempotent — and it costs nothing when there is nothing pending.
  const [checkingPayment, setCheckingPayment] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const returningFromCheckout = new URLSearchParams(window.location.search).has('ref');
      if (returningFromCheckout) setCheckingPayment(true);
      try {
        const res = await fetch('/api/wallet/deposits/sync', { method: 'POST' });
        const json = await res.json().catch(() => null);
        if (alive && json?.credited > 0) router.refresh();
      } finally {
        if (alive) setCheckingPayment(false);
      }
    })();
    return () => { alive = false; };
  }, [router]);

  // A live payout changes state from the webhook or the reconciler, not from
  // anything this page does — so listen rather than poll.
  useEffect(() => {
    const channel = supabase
      .channel('wallet')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'withdrawals' }, () => router.refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deposits' }, () => router.refresh())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, () => router.refresh())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [supabase, router]);

  const post = useCallback(async (url: string, body: unknown) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? 'Something went wrong.'); return null; }
      return json;
    } catch {
      setError('Network problem. Check your connection and try again.');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="display text-[30px] sm:text-[42px]">Wallet</h1>

      {checkingPayment && (
        <p className="mt-4 rounded-lg border border-brass-500/30 bg-brass-500/[0.07] px-4 py-3 text-[13px] text-brass-200/90">
          Confirming your payment with the bank… this usually takes a few seconds.
        </p>
      )}

      {/* ---------------------------------------------------------- balances */}
      <div className="surface mt-7 grid gap-6 p-6 sm:grid-cols-3">
        <div>
          <div className="eyebrow mb-2">Balance</div>
          <div className="money text-[24px] sm:text-[30px] font-semibold leading-none">{money(props.balanceKobo)}</div>
        </div>
        <div>
          <div className="eyebrow mb-2">Withdrawable now</div>
          <div className="tabular text-[24px] sm:text-[30px] font-semibold leading-none">
            {money(props.withdrawableKobo)}
          </div>
        </div>
        <div>
          <div className="eyebrow mb-2">Left to stake</div>
          <div className="tabular text-[24px] sm:text-[30px] font-semibold leading-none text-ivory-dim/70">
            {money(props.wageringRequiredKobo)}
          </div>
        </div>
      </div>

      {props.wageringRequiredKobo > 0 && (
        <p className="mt-3 rounded-lg border border-brass-500/25 bg-brass-500/[0.06] px-4 py-3 text-[13px] leading-relaxed text-brass-200/85">
          Deposited funds become withdrawable once they have been staked. You have{' '}
          <strong className="tabular">{money(props.wageringRequiredKobo)}</strong> still to play through.
        </p>
      )}

      {/* ---------------------------------------------------------- live payout */}
      <AnimatePresence>
        {live && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="surface mt-4 p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="eyebrow mb-2">Payout in progress</div>
                <div className="money text-[26px] font-semibold leading-none">{money(live.net_kobo)}</div>
              </div>
              <StatusPill status={live.status} />
            </div>
            <p className="mt-4 text-[13px] leading-relaxed text-ivory-dim/70">
              {STATUS_COPY[live.status]?.note}
            </p>
            <p className="mt-2 text-[12px] text-ivory-dim/45">
              Reference <code className="font-mono">{live.reference}</code> · requested {timeAgo(live.requested_at)}
            </p>
            <p className="mt-3 text-[12px] leading-relaxed text-ivory-dim/50">
              Do not request this again — the money has already left your balance and is reserved
              against this payout. If it fails, it returns automatically.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------------------------------------------------------- tabs */}
      <div className="mt-8 flex gap-6 border-b border-felt-800">
        {([['deposit', 'Add funds'], ['withdraw', 'Withdraw']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => { setTab(id); setError(null); setNotice(null); }}
            className={`relative -mb-px pb-3 text-[14px] transition-colors ${
              tab === id ? 'text-ivory' : 'text-ivory-dim/50 hover:text-ivory-dim'
            }`}
          >
            {label}
            {tab === id && (
              <motion.span
                layoutId="wallet-underline"
                className="absolute inset-x-0 -bottom-px h-px bg-brass-400"
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              />
            )}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === 'deposit'
          ? <DepositPanel settings={props.settings} busy={busy} post={post} error={error} />
          : <WithdrawPanel {...props} busy={busy} post={post} error={error} notice={notice}
              setNotice={setNotice} blocked={!!live} onDone={() => router.refresh()} />}
      </div>

      {/* ---------------------------------------------------------- history */}
      <History withdrawals={props.withdrawals} deposits={props.deposits} />
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_COPY[status] ?? { label: status, tone: 'wait' as const, note: '' };
  const tone =
    s.tone === 'good' ? 'border-jade/45 text-jade bg-jade/10'
    : s.tone === 'bad' ? 'border-oxblood/45 text-oxblood bg-oxblood/10'
    : 'border-brass-500/45 text-brass-300 bg-brass-500/10';
  return (
    <span className={`rounded-full border px-3 py-1 text-[11px] font-medium tracking-wide ${tone}`}>
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------- deposit

function DepositPanel({
  settings, busy, post, error,
}: {
  settings: PlatformSettings;
  busy: boolean;
  post: (url: string, body: unknown) => Promise<Record<string, string> | null>;
  error: string | null;
}) {
  const [amount, setAmount] = useState('');
  const kobo = nairaInputToKobo(amount);

  async function go() {
    if (!kobo) return;
    const res = await post('/api/wallet/deposit', { amountKobo: kobo });
    // Flutterwave's hosted checkout takes it from here.
    if (res?.link) window.location.href = res.link;
  }

  return (
    <div className="surface p-6">
      <label className="eyebrow mb-2.5 block">Amount</label>
      <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
        {DEPOSIT_PRESETS.map((k) => (
          <button
            key={k}
            onClick={() => setAmount(String(k / 100))}
            className={`tabular rounded-lg border py-2.5 text-[13.5px] transition-colors ${
              kobo === k
                ? 'border-brass-500/80 bg-brass-500/12 text-brass-200'
                : 'border-felt-700 text-ivory-dim/75 hover:border-felt-600 hover:text-ivory'
            }`}
          >
            {money(k)}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ivory-dim/45">₦</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="tabular w-full rounded-lg border border-felt-700 bg-felt-950/60 py-2.5 pl-8 pr-3.5 text-[15px] outline-none transition-colors focus:border-brass-500/70"
          />
        </div>
        <button
          onClick={go}
          disabled={busy || !kobo || kobo < settings.min_deposit_kobo}
          className="btn-brass hover:btn-brass-hover px-7 text-[14px] disabled:opacity-40"
        >
          {busy ? 'Opening…' : 'Continue'}
        </button>
      </div>

      <p className="mt-3 text-[12px] text-ivory-dim/50">
        Minimum {money(settings.min_deposit_kobo)}. You&apos;ll be taken to Flutterwave to pay by
        card, bank transfer or USSD, then returned here.
      </p>

      {error && <p className="mt-3 text-[13px] text-oxblood">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- withdraw

function WithdrawPanel({
  accounts, settings, withdrawableKobo, busy, post, error, notice, setNotice, blocked, onDone,
}: Props & {
  busy: boolean;
  post: (url: string, body: unknown) => Promise<Record<string, string> | null>;
  error: string | null;
  notice: string | null;
  setNotice: (s: string | null) => void;
  blocked: boolean;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const kobo = nairaInputToKobo(amount);

  const tooSmall = kobo !== null && kobo < settings.min_withdrawal_kobo;
  const tooBig = kobo !== null && kobo > settings.max_withdrawal_kobo;
  const overBalance = kobo !== null && kobo > withdrawableKobo;
  const fee = settings.withdrawal_fee_kobo;
  const lands = kobo ? Math.max(0, kobo - fee) : 0;

  async function go() {
    if (!kobo || !accountId) return;
    const res = await post('/api/wallet/withdraw', { amountKobo: kobo, bankAccountId: accountId });
    if (res) {
      setAmount('');
      setNotice(res.message ?? 'Payout submitted. You can follow it above.');
      onDone();
    }
  }

  if (accounts.length === 0) {
    return <AddAccount post={post} busy={busy} error={error} onDone={onDone} />;
  }

  if (blocked) {
    return (
      <div className="surface p-6 text-[14px] leading-relaxed text-ivory-dim/75">
        You have a payout in progress. Only one can run at a time — that is what stops a
        double payment. It will clear on its own; there is nothing to retry.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="surface p-6">
        <label className="eyebrow mb-2.5 block" htmlFor="acct">To account</label>
        <select
          id="acct"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="mb-5 w-full rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2.5 text-[14px] outline-none focus:border-brass-500/70"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.account_name} · {a.bank_name} · ····{a.account_number.slice(-4)}
              {a.is_verified ? '' : '  (name not bank-confirmed)'}
            </option>
          ))}
        </select>

        <label className="eyebrow mb-2.5 block" htmlFor="amt">Amount</label>
        <div className="relative mb-4">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ivory-dim/45">₦</span>
          <input
            id="amt"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="tabular w-full rounded-lg border border-felt-700 bg-felt-950/60 py-2.5 pl-8 pr-3.5 text-[15px] outline-none transition-colors focus:border-brass-500/70"
          />
        </div>

        <dl className="mb-5 space-y-2 rounded-lg border border-felt-800 bg-felt-950/40 px-4 py-3.5 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-ivory-dim/60">Withdrawable</dt>
            <dd className="tabular">{money(withdrawableKobo)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ivory-dim/60">Transfer fee</dt>
            <dd className="tabular">−{money(fee)}</dd>
          </div>
          <div className="flex justify-between border-t border-felt-800 pt-2">
            <dt className="text-ivory-dim/85">Lands in your bank</dt>
            <dd className="money text-[16px] font-semibold">{money(lands)}</dd>
          </div>
        </dl>

        <button
          onClick={go}
          disabled={busy || !kobo || tooSmall || tooBig || overBalance}
          className="btn-brass hover:btn-brass-hover w-full py-3.5 text-[15px] disabled:opacity-40"
        >
          {busy ? 'Submitting…'
            : tooSmall ? `Minimum is ${money(settings.min_withdrawal_kobo)}`
            : tooBig ? `Maximum is ${money(settings.max_withdrawal_kobo)}`
            : overBalance ? 'More than you can withdraw'
            : 'Withdraw'}
        </button>

        {kobo !== null && kobo >= settings.review_threshold_kobo && !tooBig && (
          <p className="mt-3 text-[12.5px] text-brass-300/85">
            Payouts of {money(settings.review_threshold_kobo)} or more are checked by a person
            first. Your funds are reserved as soon as you submit.
          </p>
        )}
        {error && <p className="mt-3 text-[13px] text-oxblood">{error}</p>}
        {notice && <p className="mt-3 text-[13px] text-jade">{notice}</p>}
      </div>

      <AddAccount post={post} busy={busy} error={null} onDone={onDone} compact />
    </div>
  );
}

function AddAccount({
  post, busy, error, onDone, compact,
}: {
  post: (url: string, body: unknown) => Promise<Record<string, string> | null>;
  busy: boolean;
  error: string | null;
  onDone: () => void;
  compact?: boolean;
}) {
  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [open, setOpen] = useState(!compact);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || banks.length) return;
    fetch('/api/wallet/banks')
      .then((r) => r.json())
      .then((j) => setBanks(j.banks ?? []))
      .catch(() => setLocalError('Could not load the bank list.'));
  }, [open, banks.length]);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-ghost px-4 py-2.5 text-[13px] hover:border-brass-500/60 hover:text-ivory">
        Add another payout account
      </button>
    );
  }

  return (
    <div className="surface p-6">
      <div className="eyebrow mb-1">Payout account</div>
      <p className="mb-5 text-[13px] leading-relaxed text-ivory-dim/65">
        We try to confirm the name with your bank. If we can&apos;t, we&apos;ll use the
        name you enter and check it by hand before sending — so make sure it matches
        the account exactly. A transfer to the wrong account cannot be recovered.
      </p>

      <select
        value={bankCode}
        onChange={(e) => setBankCode(e.target.value)}
        className="mb-3 w-full rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2.5 text-[14px] outline-none focus:border-brass-500/70"
      >
        <option value="">Select your bank…</option>
        {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
      </select>

      <input
        value={accountNumber}
        onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
        placeholder="10-digit account number"
        inputMode="numeric"
        className="tabular mb-3 w-full rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2.5 text-[15px] outline-none transition-colors placeholder:text-ivory-dim/25 focus:border-brass-500/70"
      />

      <input
        value={accountName}
        onChange={(e) => setAccountName(e.target.value)}
        placeholder="Account holder's name, exactly as the bank has it"
        className="mb-4 w-full rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2.5 text-[14px] outline-none transition-colors placeholder:text-ivory-dim/25 focus:border-brass-500/70"
      />

      <button
        onClick={async () => {
          setLocalError(null);
          const bank = banks.find((b) => b.code === bankCode);
          const res = await post('/api/wallet/banks', {
            bankCode, bankName: bank?.name ?? '', accountNumber, accountName,
          });
          if (res) {
            setLocalError(
              res.verified
                ? null
                : `Saved as "${res.accountName}". We couldn't confirm this with the bank, so it will be checked by hand before your first payout.`,
            );
            setAccountNumber(''); setAccountName(''); onDone();
          }
        }}
        disabled={busy || !bankCode || accountNumber.length !== 10 || !accountName.trim()}
        className="btn-brass hover:btn-brass-hover w-full py-3 text-[14px] disabled:opacity-40"
      >
        {busy ? 'Checking with the bank…' : 'Save payout account'}
      </button>

      {(error || localError) && (
        <p className="mt-3 text-[13px] text-oxblood">{error ?? localError}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- history

function History({ withdrawals, deposits }: { withdrawals: Withdrawal[]; deposits: Deposit[] }) {
  const rows = [
    ...deposits.map((d) => ({
      key: `d-${d.id}`, when: d.created_at, label: 'Deposit',
      amount: d.amount_kobo, sign: '+', status: d.status,
    })),
    ...withdrawals.map((w) => ({
      key: `w-${w.id}`, when: w.requested_at, label: 'Withdrawal',
      amount: w.amount_kobo, sign: '−', status: w.status,
    })),
  ].sort((a, b) => +new Date(b.when) - +new Date(a.when));

  if (rows.length === 0) return null;

  return (
    <div className="surface mt-8 overflow-hidden">
      <div className="border-b border-felt-800 px-6 py-3">
        <span className="eyebrow">Money in and out</span>
      </div>
      <div className="divide-y divide-felt-850/70">
        {rows.map((r) => (
          <div key={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-6">
            <div className="min-w-[130px] flex-1">
              <div className="text-[14px]">{r.label}</div>
              <div className="text-[12px] text-ivory-dim/45">{timeAgo(r.when)}</div>
            </div>
            <StatusPill status={r.status} />
            <div className="tabular w-28 text-right text-[14px]">
              {r.sign}{money(r.amount)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
