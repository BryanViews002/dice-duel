'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { createClient } from '@/lib/supabase/client';
import { money, moneyShort, timeAgo, STAKES } from '@/lib/format';
import { Avatar } from './Avatar';
import { Die3D } from './Die3D';

type Me = {
  id: string;
  username: string;
  avatar_seed: string;
  balance_kobo: number;
  wagering_required_kobo: number;
};

type Friend = {
  friend_id: string; username: string; avatar_seed: string;
  online: boolean; last_seen_at: string | null;
  wins_vs_me: number; losses_vs_me: number; in_match: boolean;
};

type Request = { id: string; requester_id: string; username: string; avatar_seed: string; created_at: string };
type Challenge = { match_id: string; from_id: string; username: string; avatar_seed: string; stake_kobo: number; created_at: string };
type Stats = { played: number; wins: number; losses: number; win_pct: number; profit_kobo: number };

export function Dashboard({ me, stats }: { me: Me; stats: Stats | null }) {
  const router = useRouter();
  const supabase = createClient();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [balance, setBalance] = useState(me.balance_kobo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, r, c, p] = await Promise.all([
      supabase.rpc('my_friends'),
      supabase.rpc('my_friend_requests'),
      supabase.rpc('my_challenges'),
      supabase.from('profiles').select('balance_kobo').eq('id', me.id).maybeSingle(),
    ]);
    setFriends((f.data ?? []) as Friend[]);
    setRequests((r.data ?? []) as Request[]);
    setChallenges((c.data ?? []) as Challenge[]);
    if (p.data) setBalance(p.data.balance_kobo);
  }, [supabase, me.id]);

  // ---- realtime + presence ------------------------------------------------
  useEffect(() => {
    void load();
    void supabase.rpc('touch_presence');

    // Heartbeat. 30s against a 90s "online" window, so one missed beat does
    // not make a player flicker offline.
    const beat = setInterval(() => { void supabase.rpc('touch_presence'); }, 30_000);
    // Friends' presence lives in their own rows, which we cannot subscribe to
    // per-row; a slow poll keeps the dots honest without hammering anything.
    const presence = setInterval(() => { void load(); }, 20_000);

    const channel = supabase
      .channel('dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => void load())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${me.id}` },
        (payload) => setBalance((payload.new as { balance_kobo: number }).balance_kobo))
      .subscribe();

    return () => {
      clearInterval(beat);
      clearInterval(presence);
      void supabase.removeChannel(channel);
    };
  }, [supabase, load, me.id]);

  async function run(fn: () => PromiseLike<{ error: { message: string } | null; data?: unknown }>, after?: string) {
    setBusy(true); setError(null); setNotice(null);
    const { error } = await fn();
    if (error) setError(error.message.replace(/^.*?:\s*/, ''));
    else if (after) setNotice(after);
    setBusy(false);
    await load();
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      {/* ---------------------------------------------------- greeting */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="eyebrow mb-2">Welcome back</p>
          <h1 className="display truncate text-[32px] leading-none sm:text-[46px]">{me.username}</h1>
        </div>
        <div className="text-right">
          <div className="eyebrow mb-1.5">Balance</div>
          <div className="money text-[28px] sm:text-[38px] font-semibold leading-none">{money(balance)}</div>
          {me.wagering_required_kobo > 0 && (
            <div className="mt-1.5 text-[11.5px] text-brass-300/80">
              {money(me.wagering_required_kobo)} left to stake
            </div>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------- challenges */}
      <AnimatePresence>
        {challenges.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="mt-8 space-y-3"
          >
            {challenges.map((c) => (
              <div key={c.match_id} className="surface flex flex-wrap items-center gap-x-4 gap-y-3 border-brass-500/40 p-5">
                <Avatar seed={c.avatar_seed} name={c.username} size={40} />
                <div className="min-w-[170px] flex-1">
                  <div className="text-[15px]">
                    <strong>{c.username}</strong> challenged you
                  </div>
                  <div className="mt-0.5 text-[13px] text-ivory-dim/60">
                    {money(c.stake_kobo)} each · winner takes {money(c.stake_kobo * 2 - Math.floor(c.stake_kobo * 2 * 250 / 10000))}
                  </div>
                </div>
                <button
                  onClick={() => run(async () => {
                    const res = await supabase.rpc('accept_challenge', { p_match: c.match_id, p_client_seed: '' });
                    if (!res.error) router.push('/play');
                    return res;
                  })}
                  disabled={busy || balance < c.stake_kobo}
                  className="btn-brass hover:btn-brass-hover flex-1 px-6 py-2.5 text-[14px] disabled:opacity-40 sm:flex-none"
                >
                  {balance < c.stake_kobo ? 'Not enough' : 'Accept'}
                </button>
                <button
                  onClick={() => run(() => supabase.rpc('decline_challenge', { p_match: c.match_id }))}
                  disabled={busy}
                  className="px-3 py-2.5 text-[13px] text-ivory-dim/50 transition hover:text-oxblood"
                >
                  Decline
                </button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------------------------------------------------- quick play */}
      {/*
        min-w-0 on the text block let it shrink to almost nothing while the dice
        and the button held their width, so on a phone the copy collapsed into a
        one-word-per-line column instead of wrapping onto its own row. A real
        minimum width makes flex-wrap do its job.
      */}
      <div className="surface mt-8 flex flex-wrap items-center gap-x-5 gap-y-4 p-5 sm:gap-x-6 sm:p-6">
        <div className="flex shrink-0 gap-2.5">
          <Die3D value={6} size="md" />
          <Die3D value={6} size="md" delay={120} />
        </div>
        <div className="min-w-[180px] flex-1">
          <div className="display text-[22px]">Take a seat</div>
          <div className="mt-1 text-[13.5px] leading-relaxed text-ivory-dim/65">
            Get matched with whoever is staking the same as you.
          </div>
        </div>
        <Link
          href="/play"
          className="btn-brass hover:btn-brass-hover w-full px-8 py-3 text-center text-[15px] sm:w-auto"
        >
          Find a game
        </Link>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        {/* ------------------------------------------------ friends */}
        <div className="surface overflow-hidden">
          <div className="flex items-center justify-between border-b border-felt-800 px-5 py-3">
            <span className="eyebrow">Friends</span>
            <span className="text-[11px] text-ivory-dim/40">
              {friends.filter((f) => f.online).length} online
            </span>
          </div>

          <AddFriend busy={busy} onAdd={(name) =>
            run(() => supabase.rpc('send_friend_request', { p_username: name }), 'Request sent.')} />

          {requests.length > 0 && (
            <div className="border-b border-felt-800 bg-brass-500/[0.05] px-5 py-3">
              <div className="eyebrow mb-2.5 text-[10px]">Wants to be friends</div>
              {requests.map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-1.5">
                  <Avatar seed={r.avatar_seed} name={r.username} size={28} />
                  <span className="min-w-[100px] flex-1 truncate text-[14px]">{r.username}</span>
                  <button
                    onClick={() => run(() => supabase.rpc('respond_to_friend_request', { p_id: r.id, p_accept: true }))}
                    disabled={busy}
                    className="rounded-lg border border-jade/40 px-3 py-1 text-[12px] text-jade transition hover:bg-jade/10"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => run(() => supabase.rpc('respond_to_friend_request', { p_id: r.id, p_accept: false }))}
                    disabled={busy}
                    className="px-2 py-1 text-[12px] text-ivory-dim/45 transition hover:text-oxblood"
                  >
                    Ignore
                  </button>
                </div>
              ))}
            </div>
          )}

          {friends.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-ivory-dim/40">
              No friends yet. Add someone by their table name and challenge them
              directly — no codes to pass around.
            </p>
          ) : (
            <div className="divide-y divide-felt-850/60">
              {friends.map((f) => (
                <FriendRow
                  key={f.friend_id} friend={f} balance={balance} busy={busy}
                  onChallenge={(stake) => run(
                    () => supabase.rpc('challenge_friend', { p_friend: f.friend_id, p_stake: stake, p_client_seed: '' }),
                    `Challenge sent to ${f.username}.`)}
                  onRemove={() => run(() => supabase.rpc('remove_friend', { p_friend: f.friend_id }))}
                />
              ))}
            </div>
          )}
        </div>

        {/* ------------------------------------------------ record */}
        <div className="space-y-4">
          <div className="surface p-6">
            <div className="eyebrow mb-4">Your record</div>
            {!stats || stats.played === 0 ? (
              <p className="py-4 text-[13px] text-ivory-dim/45">
                No finished matches yet.
              </p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
                {[
                  ['Played', String(stats.played)],
                  ['Won', `${stats.wins} · ${stats.win_pct}%`],
                  ['Lost', String(stats.losses)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="eyebrow mb-1 text-[10px]">{k}</dt>
                    <dd className="tabular text-[20px]">{v}</dd>
                  </div>
                ))}
                <div>
                  <dt className="eyebrow mb-1 text-[10px]">Net</dt>
                  <dd className={`tabular text-[20px] ${stats.profit_kobo >= 0 ? 'text-jade' : 'text-oxblood'}`}>
                    {stats.profit_kobo >= 0 ? '+' : '−'}{moneyShort(Math.abs(stats.profit_kobo))}
                  </dd>
                </div>
              </dl>
            )}
          </div>

          <div className="surface flex items-center justify-between gap-4 p-6">
            <div>
              <div className="text-[14px] font-medium">Wallet</div>
              <div className="mt-0.5 text-[12.5px] text-ivory-dim/60">Add funds or withdraw</div>
            </div>
            <Link href="/wallet" className="btn-ghost px-4 py-2.5 text-[13px] hover:border-brass-500/60 hover:text-ivory">
              Open
            </Link>
          </div>
        </div>
      </div>

      {error && <p className="mt-4 text-[13px] text-oxblood">{error}</p>}
      {notice && <p className="mt-4 text-[13px] text-jade">{notice}</p>}
    </div>
  );
}

function AddFriend({ busy, onAdd }: { busy: boolean; onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onAdd(name.trim()); setName(''); } }}
      className="flex gap-2 border-b border-felt-800 p-4"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Add by table name…"
        className="min-w-0 flex-1 rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2 text-[13.5px] outline-none transition-colors placeholder:text-ivory-dim/25 focus:border-brass-500/70"
      />
      <button
        type="submit" disabled={busy || !name.trim()}
        className="btn-ghost px-4 text-[13px] hover:border-brass-500/60 hover:text-ivory disabled:opacity-35"
      >
        Add
      </button>
    </form>
  );
}

function FriendRow({
  friend, balance, busy, onChallenge, onRemove,
}: {
  friend: Friend; balance: number; busy: boolean;
  onChallenge: (stake: number) => void; onRemove: () => void;
}) {
  const [picking, setPicking] = useState(false);

  return (
    <div className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative">
          <Avatar seed={friend.avatar_seed} name={friend.username} size={34} />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-felt-900 ${
              friend.online ? 'bg-jade' : 'bg-felt-600'
            }`}
            title={friend.online ? 'online' : friend.last_seen_at ? `last seen ${timeAgo(friend.last_seen_at)}` : 'offline'}
          />
        </div>

        <div className="min-w-[120px] flex-1">
          <div className="truncate text-[14.5px]">{friend.username}</div>
          <div className="text-[11.5px] text-ivory-dim/45">
            {friend.in_match
              ? 'in a match'
              : friend.online
                ? 'online'
                : friend.last_seen_at ? `seen ${timeAgo(friend.last_seen_at)}` : 'offline'}
            {(friend.wins_vs_me + friend.losses_vs_me) > 0 &&
              ` · ${friend.losses_vs_me}–${friend.wins_vs_me} to you`}
          </div>
        </div>

        <button
          onClick={() => setPicking((p) => !p)}
          disabled={busy || friend.in_match}
          className="btn-ghost px-3.5 py-1.5 text-[12.5px] hover:border-brass-500/60 hover:text-ivory disabled:opacity-30"
        >
          {picking ? 'Cancel' : 'Challenge'}
        </button>
        <button
          onClick={onRemove}
          className="px-1.5 text-[16px] leading-none text-ivory-dim/25 transition hover:text-oxblood"
          title="Remove friend"
        >
          ×
        </button>
      </div>

      <AnimatePresence>
        {picking && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {STAKES.map((s) => (
                <button
                  key={s}
                  onClick={() => { onChallenge(s); setPicking(false); }}
                  disabled={busy || balance < s}
                  className="tabular rounded-lg border border-felt-700 py-2 text-[12.5px] text-ivory-dim/75 transition hover:border-brass-500/70 hover:text-brass-200 disabled:cursor-not-allowed disabled:opacity-25"
                >
                  {moneyShort(s)}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
