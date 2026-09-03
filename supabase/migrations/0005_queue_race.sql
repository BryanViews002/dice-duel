-- ============================================================================
-- Fix: two players queueing at the same instant could both end up waiting.
--
-- THE RACE
--
-- join_queue() looks for an opponent already sitting in queue_entries, and
-- inserts itself only if it finds none. Under READ COMMITTED, a transaction
-- cannot see another transaction's uncommitted INSERT. So with two players
-- hitting "Find opponent" at the same stake close enough together:
--
--   A: SELECT ... -> empty (B has not committed)      B: SELECT ... -> empty (A has not committed)
--   A: INSERT A                                       B: INSERT B
--   A: COMMIT                                         B: COMMIT
--
-- Both are now queued at the same stake and neither is matched. Nothing ever
-- resolves it: each only searches at the moment it joins, so they sit there
-- until a third player arrives or one of them re-queues. FOR UPDATE SKIP LOCKED
-- does not help — it protects against two players claiming the SAME opponent
-- row, which is the opposite problem.
--
-- Narrow window, but this is the front door of the product and two friends
-- clicking together is exactly how it would be hit.
--
-- THE FIX
--
-- Serialise queue joins per stake with a transaction-scoped advisory lock. The
-- second transaction blocks until the first commits, then its SELECT sees the
-- waiting row and matches immediately. The lock is per stake, so tables at
-- different stakes never contend, and it releases automatically at commit or
-- rollback.
-- ============================================================================

create or replace function public.join_queue(p_stake bigint, p_client_seed text)
returns uuid
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  bal bigint;
  opponent public.queue_entries;
  seed text := coalesce(nullif(trim(p_client_seed), ''), encode(extensions.gen_random_bytes(8), 'hex'));
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_stake <= 0 then raise exception 'invalid stake'; end if;

  -- Only one join per stake may be in flight at a time. Held until commit.
  perform pg_advisory_xact_lock(hashtext('dice_duel:queue:' || p_stake::text));

  select balance_cents into bal from public.profiles where id = uid for update;
  if bal is null then raise exception 'no profile'; end if;
  if bal < p_stake then raise exception 'insufficient balance'; end if;

  if exists (select 1 from public.matches
              where status in ('waiting','playing') and (player_a = uid or player_b = uid)) then
    raise exception 'you are already in a match';
  end if;

  select * into opponent
    from public.queue_entries q
   where q.stake_cents = p_stake
     and q.player_id <> uid
     and exists (select 1 from public.profiles p where p.id = q.player_id and p.balance_cents >= p_stake)
   order by q.created_at
   for update skip locked
   limit 1;

  if found then
    return public.start_match(opponent.player_id, uid, p_stake, opponent.client_seed, seed);
  end if;

  insert into public.queue_entries (player_id, stake_cents, client_seed)
  values (uid, p_stake, seed)
  on conflict (player_id) do update set stake_cents = excluded.stake_cents,
                                        client_seed = excluded.client_seed,
                                        created_at = now();
  return null;
end $$;

grant execute on function public.join_queue(bigint, text) to authenticated;

-- Clear any pair already stranded by the race so they can re-queue cleanly.
delete from public.queue_entries
 where stake_cents in (
   select stake_cents from public.queue_entries group by stake_cents having count(*) > 1
 );
