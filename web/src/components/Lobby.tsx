'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { money, STAKES } from '@/lib/format';
import { potMath } from '@/lib/game';
import { Die3D } from './Die3D';

export function Lobby({
  balanceKobo,
  queued,
  inviteCode,
  busy,
  error,
  notice,
  onFindOpponent,
  onCancelQueue,
  onCreateTable,
  onCancelTable,
  onJoinCode,
}: {
  balanceKobo: number;
  queued: boolean;
  inviteCode: string | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onFindOpponent: (stake: number, seed: string) => void;
  onCancelQueue: () => void;
  onCreateTable: (stake: number, seed: string) => void;
  onCancelTable: () => void;
  onJoinCode: (code: string, seed: string) => void;
}) {
  // Derived from STAKES rather than hard-coded: a literal here silently drifts
  // out of range whenever the ladder changes, leaving no button selected and the
  // button quoting a stake that is not on offer.
  const [stake, setStake] = useState<number>(STAKES[0]);
  const [seed, setSeed] = useState(() => Math.random().toString(36).slice(2, 10));
  const [code, setCode] = useState('');
  const [tab, setTab] = useState<'quick' | 'private'>('quick');

  const affordable = balanceKobo >= stake;
  const pot = potMath(stake, 250);

  // ---------------------------------------------------------------- waiting
  if (inviteCode) {
    return (
      <Centered>
        <p className="eyebrow mb-3">Private table open</p>
        <h2 className="display mb-6 text-[30px]">Waiting on your challenger</h2>

        <div className="surface-raised mb-7 px-8 py-7">
          <div className="eyebrow mb-3 text-[10px]">Invite code</div>
          <div className="font-mono text-[42px] font-medium leading-none tracking-[0.28em] text-brass-300">
            {inviteCode}
          </div>
        </div>

        <div className="mb-8 flex items-center justify-center gap-2.5 text-[13px] text-ivory-dim/60">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brass-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brass-500" />
          </span>
          Table stays open until they arrive
        </div>

        <div className="flex justify-center gap-3">
          <button
            onClick={() => navigator.clipboard?.writeText(inviteCode)}
            className="btn-ghost px-5 py-2.5 text-[13px] hover:border-brass-500/60 hover:text-ivory"
          >
            Copy code
          </button>
          <button
            onClick={onCancelTable}
            className="px-4 py-2.5 text-[13px] text-ivory-dim/50 transition-colors hover:text-oxblood"
          >
            Close table
          </button>
        </div>
      </Centered>
    );
  }

  if (queued) {
    return (
      <Centered>
        <div className="mb-8 flex justify-center gap-4">
          <SpinningDie delay={0} />
          <SpinningDie delay={280} />
        </div>
        <p className="eyebrow mb-3">Matchmaking</p>
        <h2 className="display mb-3 text-[30px]">Finding an opponent</h2>
        <p className="mb-8 text-[14px] text-ivory-dim/70">
          Looking for someone staking {money(stake)}. You&apos;ll be seated the moment
          they appear.
        </p>
        <button
          onClick={onCancelQueue}
          className="btn-ghost px-5 py-2.5 text-[13px] hover:border-oxblood/50 hover:text-oxblood"
        >
          Leave the queue
        </button>
      </Centered>
    );
  }

  // ---------------------------------------------------------------- lobby
  return (
    <div className="mx-auto max-w-lg animate-rise">
      <div className="surface p-7">
        <div className="mb-7 flex gap-6 border-b border-felt-800">
          {([['quick', 'Quick match'], ['private', 'Private table']] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`relative -mb-px pb-3 text-[13.5px] transition-colors ${
                tab === id ? 'text-ivory' : 'text-ivory-dim/50 hover:text-ivory-dim'
              }`}
            >
              {label}
              {tab === id && (
                <motion.span
                  layoutId="lobby-underline"
                  className="absolute inset-x-0 -bottom-px h-px bg-brass-400"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
            </button>
          ))}
        </div>

        <AnimatePresence initial={false}>
          {tab === 'private' && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <label className="eyebrow mb-2.5 block" htmlFor="code">
                Join with a code
              </label>
              <div className="mb-7 flex gap-2">
                <input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
                  placeholder="ABC123"
                  className="min-w-0 flex-1 rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2.5 font-mono text-[15px] tracking-[0.25em] outline-none transition-colors placeholder:text-ivory-dim/20 focus:border-brass-500/70"
                />
                <button
                  onClick={() => onJoinCode(code, seed)}
                  disabled={busy || code.length < 6}
                  className="btn-ghost px-5 text-[13px] hover:border-brass-500/60 hover:text-ivory disabled:opacity-35"
                >
                  Join
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mb-2.5 flex items-baseline justify-between">
          <label className="eyebrow">Stake — each side posts this</label>
          <span className="text-[11px] text-ivory-dim/45">
            you hold {money(balanceKobo)}
          </span>
        </div>

        <div className="mb-6 grid grid-cols-3 gap-2">
          {STAKES.map((s) => {
            const can = balanceKobo >= s;
            const on = stake === s;
            return (
              <button
                key={s}
                onClick={() => setStake(s)}
                disabled={!can}
                className={`tabular rounded-lg border py-2.5 text-[14px] font-medium transition-all ${
                  on
                    ? 'border-brass-500/80 bg-brass-500/12 text-brass-200 shadow-[inset_0_1px_0_rgba(255,255,255,.08)]'
                    : can
                      ? 'border-felt-700 text-ivory-dim/75 hover:border-felt-600 hover:text-ivory'
                      : 'cursor-not-allowed border-felt-850 text-ivory-dim/20'
                }`}
              >
                {money(s)}
              </button>
            );
          })}
        </div>

        <div className="mb-6 flex items-center justify-between rounded-lg border border-felt-800 bg-felt-950/40 px-4 py-3.5">
          <span className="text-[13px] text-ivory-dim/65">Winner takes</span>
          <span className="money text-[21px] font-semibold">{money(pot.payout)}</span>
        </div>

        <label className="eyebrow mb-2.5 block" htmlFor="seed">
          Your client seed
        </label>
        <input
          id="seed"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          maxLength={64}
          className="w-full rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2.5 font-mono text-[13px] outline-none transition-colors focus:border-brass-500/70"
        />
        <p className="mb-6 mt-2 text-[11.5px] leading-relaxed text-ivory-dim/45">
          Mixed into every roll alongside the house seed, so neither side can
          choose the outcome alone.
        </p>

        <button
          onClick={() => (tab === 'quick' ? onFindOpponent(stake, seed) : onCreateTable(stake, seed))}
          disabled={busy || !affordable}
          className="btn-brass hover:btn-brass-hover w-full py-3.5 text-[15px] active:translate-y-px disabled:opacity-40"
        >
          {!affordable
            ? `Not enough chips for ${money(stake)}`
            : busy
              ? 'One moment…'
              : tab === 'quick'
                ? `Find opponent · ${money(stake)}`
                : `Open table · ${money(stake)}`}
        </button>

        {error && <p className="mt-3.5 text-[13px] text-oxblood">{error}</p>}
        {notice && <p className="mt-3.5 text-[13px] text-jade">{notice}</p>}
      </div>

    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md animate-rise">
      <div className="surface p-10 text-center">{children}</div>
    </div>
  );
}

/** Continuously tumbling die for the waiting states. */
function SpinningDie({ delay }: { delay: number }) {
  return (
    <div
      className="animate-drift"
      style={{ animationDelay: `${delay}ms`, animationDuration: '3.2s' }}
    >
      <Die3D value={null} size="md" idle />
    </div>
  );
}
