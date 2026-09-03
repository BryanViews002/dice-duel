-- ============================================================================
-- Fix: roll() and roll_as() could never finish a match.
--
-- THE BUG
--
-- `outcome` is public.round_result, whose values are 'A' | 'B' | 'TIE'.
-- finish_match() takes public.seat, whose values are 'a' | 'b'.
--
-- 0001 called `perform public.finish_match(m.id, outcome)` with no conversion.
-- Postgres will not implicitly cast between two distinct enum types, so the
-- call failed to resolve at runtime with:
--
--   42883  No function matches the given name and argument types.
--
-- Effect: the round that DECIDED a match always threw. Player B's roll rolled
-- back, the pot was never paid out, the seed was never revealed, and the match
-- sat at status 'playing' with both stakes escrowed until the 30s clock and
-- claim_timeout() were used - which hit the identical error. Every match was
-- unwinnable and every stake stuck.
--
-- Tied rounds worked fine, which is why this needed a live decisive round to
-- surface: the TIE branch calls deal_round(), not finish_match().
--
-- THE FIX
--
-- Convert explicitly: 'A' -> 'a', 'B' -> 'b'. Applied in both roll() and its
-- internal twin roll_as(), which carried the same line.
-- ============================================================================

create or replace function public.roll(p_match_id uuid)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  m       public.matches;
  uid     uuid := auth.uid();
  s       public.seat;
  seed    text;
  r       public.match_rounds;
  d_a smallint[]; d_b smallint[];
  sa smallint; sb smallint;
  outcome public.round_result;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into m from public.matches where id = p_match_id for update;
  if not found then raise exception 'no such match'; end if;
  if m.status <> 'playing' then raise exception 'match is not accepting rolls'; end if;

  s := case when m.player_a = uid then 'a'
            when m.player_b = uid then 'b'
            else null end;
  if s is null then raise exception 'you are not in this match'; end if;
  if m.turn <> s then raise exception 'not your turn'; end if;

  select server_seed into seed from public.match_secrets where match_id = m.id;
  select * into r from public.match_rounds where match_id = m.id and round_no = m.round;

  if s = 'a' then
    d_a := public.fair_dice(seed, m.client_seed_a, m.client_seed_b, m.round, 'A');
    update public.match_rounds
       set dice_a = d_a, score_a = public.count_sixes(d_a)
     where match_id = m.id and round_no = m.round;

    update public.matches
       set turn = 'b', roll_deadline = now() + interval '30 seconds'
     where id = m.id;
    return;
  end if;

  d_b := public.fair_dice(seed, m.client_seed_a, m.client_seed_b, m.round, 'B');
  d_a := r.dice_a;
  sa := public.count_sixes(d_a);
  sb := public.count_sixes(d_b);
  outcome := case when sa > sb then 'A' when sb > sa then 'B' else 'TIE' end;

  update public.match_rounds
     set dice_b = d_b, score_b = sb, score_a = sa, result = outcome
   where match_id = m.id and round_no = m.round;

  if outcome = 'TIE' then
    if m.round >= 64 then
      perform public.adjust_balance(m.player_a, m.stake_cents, 'refund', m.id);
      perform public.adjust_balance(m.player_b, m.stake_cents, 'refund', m.id);
      update public.matches set status = 'void', roll_deadline = null, finished_at = now()
       where id = m.id;
    else
      select * into m from public.matches where id = m.id;
      perform public.deal_round(m);
    end if;
  else
    -- round_result ('A'/'B') -> seat ('a'/'b'). No implicit cast exists.
    perform public.finish_match(m.id, lower(outcome::text)::public.seat);
  end if;
end $$;

create or replace function public.roll_as(p_match_id uuid, p_player uuid)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  m public.matches; s public.seat; seed text; r public.match_rounds;
  d_a smallint[]; d_b smallint[]; sa smallint; sb smallint; outcome public.round_result;
begin
  select * into m from public.matches where id = p_match_id for update;
  if m.status <> 'playing' then return; end if;
  s := case when m.player_a = p_player then 'a' when m.player_b = p_player then 'b' else null end;
  if s is null or m.turn <> s then return; end if;

  select server_seed into seed from public.match_secrets where match_id = m.id;
  select * into r from public.match_rounds where match_id = m.id and round_no = m.round;

  if s = 'a' then
    d_a := public.fair_dice(seed, m.client_seed_a, m.client_seed_b, m.round, 'A');
    update public.match_rounds set dice_a = d_a, score_a = public.count_sixes(d_a)
     where match_id = m.id and round_no = m.round;
    update public.matches set turn = 'b', roll_deadline = now() + interval '30 seconds'
     where id = m.id;
    return;
  end if;

  d_b := public.fair_dice(seed, m.client_seed_a, m.client_seed_b, m.round, 'B');
  d_a := r.dice_a;
  sa := public.count_sixes(d_a); sb := public.count_sixes(d_b);
  outcome := case when sa > sb then 'A' when sb > sa then 'B' else 'TIE' end;

  update public.match_rounds set dice_b = d_b, score_b = sb, score_a = sa, result = outcome
   where match_id = m.id and round_no = m.round;

  if outcome = 'TIE' then
    if m.round >= 64 then
      perform public.adjust_balance(m.player_a, m.stake_cents, 'refund', m.id);
      perform public.adjust_balance(m.player_b, m.stake_cents, 'refund', m.id);
      update public.matches set status = 'void', roll_deadline = null, finished_at = now() where id = m.id;
    else
      select * into m from public.matches where id = m.id;
      perform public.deal_round(m);
    end if;
  else
    perform public.finish_match(m.id, lower(outcome::text)::public.seat);
  end if;
end $$;

-- Release any match already wedged by the bug: refund both escrowed stakes.
do $$
declare m public.matches;
begin
  for m in select * from public.matches where status = 'playing' loop
    perform public.adjust_balance(m.player_a, m.stake_cents, 'refund', m.id);
    perform public.adjust_balance(m.player_b, m.stake_cents, 'refund', m.id);
    update public.matches
       set status = 'void', roll_deadline = null, finished_at = now()
     where id = m.id;
  end loop;
end $$;
