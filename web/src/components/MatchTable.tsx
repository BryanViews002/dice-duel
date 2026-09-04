'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { DicePair } from './Die3D';
import { Avatar } from './Avatar';
import { money, signedMoney } from '@/lib/format';
import { countSixes, potMath, scoreLabel, verifyProof, type VerifyReport } from '@/lib/game';
import type { Match, MatchRound } from '@/lib/types';

type Player = { id: string; name: string; avatarSeed: string };

export function MatchTable({
  match, rounds, me, them, mySeat,
  onRoll, onClaimTimeout, onLeave, busy, error,
}: {
  match: Match;
  rounds: MatchRound[];
  me: Player;
  them: Player;
  mySeat: 'a' | 'b';
  onRoll: () => void;
  onClaimTimeout: () => void;
  onLeave: () => void;
  busy: boolean;
  error: string | null;
}) {
  const theirSeat = mySeat === 'a' ? 'b' : 'a';
  const current = rounds.find((r) => r.round_no === match.round) ?? null;
  const decided = rounds.filter((r) => r.result !== null);
  const lastDecided = decided[decided.length - 1] ?? null;

  const myDice = current ? (mySeat === 'a' ? current.dice_a : current.dice_b) : null;
  const theirDice = current ? (theirSeat === 'a' ? current.dice_a : current.dice_b) : null;

  const live = match.status === 'playing';
  const myTurn = live && match.turn === mySeat;
  const finished = match.status === 'finished';
  const iWon = finished && match.winner === mySeat;
  const pot = potMath(match.stake_kobo, match.rake_bps);

  // ---- turn clock --------------------------------------------------------
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [live]);

  const msLeft = match.roll_deadline ? new Date(match.roll_deadline).getTime() - now : null;
  const secsLeft = msLeft === null ? null : Math.max(0, Math.ceil(msLeft / 1000));
  const expired = msLeft !== null && msLeft <= 0;
  const clockPct = msLeft === null ? 0 : Math.max(0, Math.min(1, msLeft / 30000));

  // ---- fairness ----------------------------------------------------------
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [verifying, setVerifying] = useState(false);

  const proof = useMemo(
    () => match.revealed_server_seed && match.client_seed_b
      ? {
          server_seed_hash: match.server_seed_hash,
          revealed_server_seed: match.revealed_server_seed,
          client_seed_a: match.client_seed_a,
          client_seed_b: match.client_seed_b,
          rounds: rounds.map((r) => ({
            round_no: r.round_no, dice_a: r.dice_a, dice_b: r.dice_b, result: r.result,
          })),
        }
      : null,
    [match, rounds],
  );

  async function verify() {
    if (!proof) return;
    setVerifying(true);
    setReport(await verifyProof(proof));
    setVerifying(false);
  }

  const headline = finished
    ? (iWon ? 'You take the pot' : `${them.name} takes it`)
    : match.status === 'void' ? 'Match voided'
    : myTurn ? 'Your roll'
    : `${them.name} to roll`;

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------- pot ledger */}
      <div className="surface flex flex-wrap items-center gap-x-6 gap-y-4 px-4 py-4 sm:gap-x-10 sm:px-6">
        <div>
          <div className="eyebrow mb-1.5">Pot</div>
          <div className="money text-[24px] sm:text-[30px] font-semibold leading-none">{money(pot.pot)}</div>
        </div>
        <div className="hidden h-9 w-px bg-felt-700 sm:block" />
        <dl className="flex gap-5 text-[12.5px] sm:gap-8">
          <div>
            <dt className="eyebrow mb-1.5 text-[10px]">Stake each</dt>
            <dd className="tabular text-ivory-dim">{money(match.stake_kobo)}</dd>
          </div>
          <div>
            <dt className="eyebrow mb-1.5 text-[10px]">Winner takes</dt>
            <dd className="tabular text-ivory">{money(pot.payout)}</dd>
          </div>
          <div>
            <dt className="eyebrow mb-1.5 text-[10px]">Rake</dt>
            <dd className="tabular text-ivory-dim/70">{money(pot.rake)}</dd>
          </div>
        </dl>
        <div className="ml-auto text-right">
          <div className="eyebrow mb-1.5">Round</div>
          <div className="tabular text-[24px] sm:text-[30px] font-semibold leading-none">{match.round}</div>
        </div>
      </div>

      {/* ---------------------------------------------------- the felt */}
      <div className="surface relative overflow-hidden">
        {/* lamp pool over the table */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(60% 70% at 50% 0%, rgba(201,162,39,.10) 0%, transparent 70%)',
          }}
        />

        {/* turn clock as a hairline across the top */}
        {live && (
          <div className="absolute inset-x-0 top-0 h-px bg-felt-700">
            <motion.div
              className={expired ? 'h-px bg-oxblood' : 'h-px bg-brass-400'}
              animate={{ width: `${clockPct * 100}%` }}
              transition={{ ease: 'linear', duration: 0.2 }}
            />
          </div>
        )}

        <div className="relative grid items-stretch gap-3 p-6 sm:grid-cols-[1fr_auto_1fr] sm:p-8">
          <Seat
            player={me} caption="You" dice={myDice}
            active={myTurn} outcome={finished ? (iWon ? 'won' : 'lost') : null}
          />
          <div className="flex items-center justify-center">
            <span className="display text-[15px] text-ivory-dim/35">vs</span>
          </div>
          <Seat
            player={them} caption="Opponent" dice={theirDice}
            active={live && match.turn === theirSeat}
            outcome={finished ? (iWon ? 'lost' : 'won') : null}
          />
        </div>

        {/* ------------------------------------------------ action */}
        <div className="relative border-t border-felt-800 px-4 py-6 text-center sm:px-6">
          {/*
            Keyed motion.p, deliberately NOT wrapped in AnimatePresence.

            Realtime delivers several headline changes in quick succession
            ("Your roll" -> "them to roll" -> "them takes it", often inside a
            few hundred ms). With `mode="wait"` the enter animation waits on the
            previous exit, and a third change mid-flight strands it — the result
            headline was measured stuck at opacity 0.4, i.e. the single most
            important line on the table rendered mostly invisible.

            Remounting on key gives every headline a fresh initial -> animate
            with nothing to coordinate against, so it always lands at opacity 1.
          */}
          <motion.p
            key={headline}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className={`display text-[27px] ${
              finished ? (iWon ? 'text-jade' : 'text-oxblood') : myTurn ? 'text-brass-300' : 'text-ivory-dim'
            }`}
          >
            {headline}
          </motion.p>

          {finished && (
            <p className={`tabular mt-1.5 text-[15px] ${iWon ? 'text-jade' : 'text-oxblood'}`}>
              {signedMoney(iWon ? pot.payout - match.stake_kobo : -match.stake_kobo)}
            </p>
          )}

          {lastDecided?.result === 'TIE' && live && (
            <p className="mt-1.5 text-[13px] text-brass-400/85">
              Both showed {scoreLabel(lastDecided.dice_a)} — level, so it goes again.
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {live && (
              <button
                onClick={onRoll}
                disabled={!myTurn || busy}
                className={
                  myTurn && !busy
                    ? 'btn-brass hover:btn-brass-hover px-11 py-3.5 text-[16px] active:translate-y-px'
                    : 'cursor-not-allowed rounded-[10px] border border-felt-800 px-11 py-3.5 text-[16px] text-ivory-dim/25'
                }
              >
                {busy ? 'Rolling…' : 'Roll'}
              </button>
            )}

            {(finished || match.status === 'void') && (
              <button
                onClick={onLeave}
                className="btn-brass hover:btn-brass-hover px-11 py-3.5 text-[16px] active:translate-y-px"
              >
                Play again
              </button>
            )}

            {live && !myTurn && expired && (
              <button
                onClick={onClaimTimeout}
                className="btn-ghost px-4 py-3 text-[13px] text-oxblood hover:border-oxblood/50"
              >
                Clock&apos;s out — roll for them
              </button>
            )}
          </div>

          {live && secsLeft !== null && (
            <p className="tabular mt-3.5 text-[11.5px] text-ivory-dim/40">
              {expired ? 'clock expired' : `${secsLeft}s`}
            </p>
          )}

          {error && <p className="mt-3 text-[13px] text-oxblood">{error}</p>}
        </div>
      </div>

      {/* ---------------------------------------------------- rounds */}
      {decided.length > 0 && (
        <div className="surface overflow-hidden">
          <div className="border-b border-felt-800 px-6 py-3">
            <span className="eyebrow">Rounds</span>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-[13.5px]">
            <thead>
              <tr className="border-b border-felt-850">
                <th className="eyebrow px-6 py-2.5 text-left text-[10px] font-medium">#</th>
                <th className="eyebrow px-3 py-2.5 text-left text-[10px] font-medium">You</th>
                <th className="eyebrow px-3 py-2.5 text-left text-[10px] font-medium">{them.name}</th>
                <th className="eyebrow px-6 py-2.5 text-right text-[10px] font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((r) => {
                const mine = mySeat === 'a' ? r.dice_a : r.dice_b;
                const theirs = mySeat === 'a' ? r.dice_b : r.dice_a;
                const verdict = r.result === 'TIE' ? 'level — replayed'
                  : r.result === mySeat.toUpperCase() ? 'you win' : 'they win';
                return (
                  <tr key={r.round_no} className="border-b border-felt-850/60 last:border-0">
                    <td className="tabular px-6 py-2.5 text-ivory-dim/35">{r.round_no}</td>
                    <td className="tabular px-3 py-2.5">
                      {mine?.join(' · ')} <SixCount n={countSixes(mine)} />
                    </td>
                    <td className="tabular px-3 py-2.5">
                      {theirs?.join(' · ')} <SixCount n={countSixes(theirs)} />
                    </td>
                    <td className={`px-6 py-2.5 text-right ${
                      verdict === 'you win' ? 'text-jade'
                        : verdict === 'they win' ? 'text-oxblood' : 'text-ivory-dim/50'
                    }`}>
                      {verdict}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- proof */}
      <details className="surface group px-6 py-4 [&_summary]:cursor-pointer [&_summary]:list-none">
        <summary className="eyebrow flex items-center justify-between">
          Fairness proof
          <span className="text-ivory-dim/40 transition-transform group-open:rotate-45">+</span>
        </summary>
        <div className="mt-5 space-y-4">
          <Field label="Seed commitment · published before any dice were rolled" value={match.server_seed_hash} />
          <Field label="Your client seed" value={(mySeat === 'a' ? match.client_seed_a : match.client_seed_b) ?? ''} />
          {match.revealed_server_seed ? (
            <>
              <Field label="Revealed server seed" value={match.revealed_server_seed} />
              <button
                onClick={verify}
                disabled={verifying}
                className="btn-ghost px-4 py-2.5 text-[12.5px] hover:border-brass-500/60 hover:text-ivory disabled:opacity-45"
              >
                {verifying ? 'Recomputing…' : 'Recompute every die in my browser'}
              </button>
              {report && (
                <p className={`text-[13px] ${report.ok ? 'text-jade' : 'text-oxblood'}`}>
                  {report.ok ? '✓ ' : '✗ '}{report.reason}
                </p>
              )}
            </>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ivory-dim/55">
              The house seed stays sealed until this match ends — it is not readable by
              anyone, including you, while chips are at risk. It is revealed the moment
              the pot is settled.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

function SixCount({ n }: { n: number }) {
  return (
    <span className={n > 0 ? 'text-brass-400' : 'text-ivory-dim/30'}>
      ({n})
    </span>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="eyebrow mb-1.5 text-[10px]">{label}</div>
      <code className="block break-all rounded-lg border border-felt-800 bg-felt-950/60 px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-ivory-dim/70">
        {value || '—'}
      </code>
    </div>
  );
}

function Seat({
  player, caption, dice, active, outcome,
}: {
  player: Player;
  caption: string;
  dice: number[] | null;
  active: boolean;
  outcome: 'won' | 'lost' | null;
}) {
  const sixes = countSixes(dice);
  return (
    <motion.div
      animate={{ opacity: outcome === 'lost' ? 0.55 : 1 }}
      className={`relative flex flex-col items-center rounded-xl border px-5 py-7 transition-colors ${
        outcome === 'won'
          ? 'border-jade/45 bg-jade/[0.055]'
          : outcome === 'lost'
            ? 'border-felt-800 bg-transparent'
            : active
              ? 'border-brass-500/55 bg-brass-500/[0.045]'
              : 'border-felt-800 bg-felt-950/25'
      }`}
    >
      <div className="mb-5 flex items-center gap-2.5">
        <Avatar seed={player.avatarSeed} name={player.name} size={26} />
        <div className="text-left leading-tight">
          <div className="text-[14px] font-medium">{player.name}</div>
          <div className="eyebrow text-[9.5px]">{caption}</div>
        </div>
      </div>

      <div className="py-2">
        <DicePair dice={dice} idle={!dice && active} />
      </div>

      <div className={`mt-6 text-[13px] ${sixes > 0 ? 'text-brass-300' : 'text-ivory-dim/45'}`}>
        {dice ? scoreLabel(dice) : active ? 'to roll' : '—'}
      </div>

      {active && !outcome && (
        <motion.span
          layoutId="turn-marker"
          className="absolute -bottom-px left-1/2 h-px w-16 -translate-x-1/2 bg-brass-400"
          transition={{ type: 'spring', stiffness: 400, damping: 35 }}
        />
      )}
    </motion.div>
  );
}
