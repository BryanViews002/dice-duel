'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import type { Match, MatchRound, PublicProfile } from '@/lib/types';
import { Lobby } from './Lobby';
import { MatchTable } from './MatchTable';
import { Chat } from './Chat';
import { TableBackground } from './TableBackground';

type Me = { id: string; username: string; avatar_seed: string; balance_kobo: number };

export function PlayClient({ me }: { me: Me }) {
  const router = useRouter();
  const supabase = useRef(createClient()).current;

  const [balance, setBalance] = useState(me.balance_kobo);
  const [match, setMatch] = useState<Match | null>(null);
  const [rounds, setRounds] = useState<MatchRound[]>([]);
  const [opponent, setOpponent] = useState<PublicProfile | null>(null);
  const [queued, setQueued] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Set when the player dismisses a finished match, so refresh() does not
  // immediately pull it back onto the screen.
  const dismissed = useRef<string | null>(null);
  // The match currently on screen. Needed because a finished match is no longer
  // "active", so refresh() has to know what to re-read to pick up the result.
  const currentId = useRef<string | null>(null);

  const loadMatch = useCallback(
    async (matchId: string) => {
      const [{ data: m }, { data: rs }] = await Promise.all([
        supabase.from('matches').select('*').eq('id', matchId).maybeSingle(),
        supabase.from('match_rounds').select('*').eq('match_id', matchId).order('round_no'),
      ]);
      if (!m) return;

      const match = m as Match;
      currentId.current = match.id;
      setMatch(match);
      setRounds((rs ?? []) as MatchRound[]);

      const otherId = match.player_a === me.id ? match.player_b : match.player_a;
      if (otherId) {
        const { data: p } = await supabase
          .from('public_profiles')
          .select('*')
          .eq('id', otherId)
          .maybeSingle();
        if (p) setOpponent(p as PublicProfile);
      }
    },
    [supabase, me.id],
  );

  /** Reconcile local state with the database. Cheap, and always correct. */
  const refresh = useCallback(async () => {
    const { data: rows } = await supabase
      .from('matches')
      .select('*')
      .in('status', ['waiting', 'playing'])
      .or(`player_a.eq.${me.id},player_b.eq.${me.id}`)
      .order('created_at', { ascending: false })
      .limit(1);

    const active = (rows?.[0] ?? null) as Match | null;

    if (active && active.status === 'waiting' && active.is_private && !active.player_b) {
      setInviteCode(active.invite_code);
      setMatch(null);
      setQueued(false);
      return;
    }

    setInviteCode(null);

    if (active && active.id !== dismissed.current) {
      setQueued(false);
      await loadMatch(active.id);
      return;
    }

    // A match that just ended is no longer "active", so re-read the one we were
    // playing to pick up the winner, payout and revealed seed. Without this the
    // table freezes on the last live state after the deciding roll.
    if (currentId.current && currentId.current !== dismissed.current) {
      setQueued(false);
      await loadMatch(currentId.current);
      return;
    }

    // No live match: are we sitting in the matchmaking queue?
    const { data: q } = await supabase
      .from('queue_entries')
      .select('player_id')
      .eq('player_id', me.id)
      .maybeSingle();
    setQueued(!!q);
  }, [supabase, me.id, loadMatch]);

  // ---- initial load ------------------------------------------------------
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- realtime: anything involving me ------------------------------------
  useEffect(() => {
    const onChange = () => void refresh();

    const channel: RealtimeChannel = supabase
      .channel(`play:${me.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `player_a=eq.${me.id}` }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `player_b=eq.${me.id}` }, onChange)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${me.id}` },
        (payload) => {
          const next = (payload.new as { balance_kobo: number }).balance_kobo;
          setBalance(next);
          router.refresh(); // keeps the balance in the nav bar honest
        })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, me.id, refresh, router]);

  // ---- realtime: dice for the current match --------------------------------
  useEffect(() => {
    if (!match) return;
    const channel = supabase
      .channel(`rounds:${match.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'match_rounds', filter: `match_id=eq.${match.id}` },
        () => void loadMatch(match.id),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, match?.id, loadMatch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Safety net: realtime can drop a message on a flaky connection, and a stuck
  // lobby is the one place the player cannot recover from on their own.
  useEffect(() => {
    if (!queued && !inviteCode) return;
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [queued, inviteCode, refresh]);

  // ---- actions ------------------------------------------------------------
  // Supabase query builders are thenables rather than real Promises, so this
  // takes PromiseLike and awaits it.
  async function run(
    fn: () => PromiseLike<{ error: { message: string } | null }>,
    after?: () => void,
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error } = await fn();
    if (error) setError(error.message.replace(/^.*?:\s*/, ''));
    else after?.();
    setBusy(false);
    await refresh();
  }

  const findOpponent = (stake: number, seed: string) =>
    run(() => supabase.rpc('join_queue', { p_stake: stake, p_client_seed: seed }));

  const cancelQueue = () => run(() => supabase.rpc('leave_queue'), () => setQueued(false));

  const createTable = (stake: number, seed: string) =>
    run(() => supabase.rpc('create_private_table', { p_stake: stake, p_client_seed: seed }));

  const cancelTable = () => run(() => supabase.rpc('cancel_private_table'), () => setInviteCode(null));

  const joinCode = (code: string, seed: string) =>
    run(() => supabase.rpc('join_private_table', { p_code: code, p_client_seed: seed }));

  const roll = () => {
    if (!match) return;
    return run(() => supabase.rpc('roll', { p_match_id: match.id }));
  };

  const claimTimeout = () => {
    if (!match) return;
    return run(() => supabase.rpc('claim_timeout', { p_match_id: match.id }));
  };

  function leaveTable() {
    if (match) dismissed.current = match.id;
    currentId.current = null;
    setMatch(null);
    setRounds([]);
    setOpponent(null);
    setError(null);
    void refresh();
  }

  // ---- render -------------------------------------------------------------
  const mySeat: 'a' | 'b' | null = match
    ? match.player_a === me.id
      ? 'a'
      : match.player_b === me.id
        ? 'b'
        : null
    : null;

  if (!match || !mySeat || !opponent) {
    return (
      <>
        <TableBackground />
        <div className="px-6 py-14">
          <Lobby
          balanceKobo={balance}
          queued={queued}
          inviteCode={inviteCode}
          busy={busy}
          error={error}
          notice={notice}
          onFindOpponent={findOpponent}
          onCancelQueue={cancelQueue}
          onCreateTable={createTable}
          onCancelTable={cancelTable}
          onJoinCode={joinCode}
            />
        </div>
      </>
    );
  }

  return (
    <>
      <TableBackground intensity={0.55} />
      <div className="mx-auto grid max-w-6xl gap-4 px-6 py-8 lg:grid-cols-[1fr_330px]">
      <MatchTable
        match={match}
        rounds={rounds}
        me={{ id: me.id, name: me.username, avatarSeed: me.avatar_seed }}
        them={{ id: opponent.id, name: opponent.username, avatarSeed: opponent.avatar_seed }}
        mySeat={mySeat}
        onRoll={roll}
        onClaimTimeout={claimTimeout}
        onLeave={leaveTable}
        busy={busy}
        error={error}
      />
      <div className="h-[540px] lg:h-auto">
          <Chat matchId={match.id} meId={me.id} meName={me.username} themName={opponent.username} />
        </div>
      </div>
    </>
  );
}
