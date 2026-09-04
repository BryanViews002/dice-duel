-- ============================================================================
-- Stake limits, and the deposit safety net.
--
-- 1. STAKE LIMITS
--
--    join_queue accepted ANY positive stake. The six buttons on the table are
--    only a client-side list, so a crafted request could open a match at any
--    amount at all — ₦1 or ₦50,000,000 — bypassing every figure shown to
--    players. Stakes are now bounded in the database like everything else.
--
-- 2. DEPOSIT RECOVERY  ** the gap that could take a player's money **
--
--    Crediting a deposit depended entirely on Flutterwave's webhook arriving.
--    Webhooks get dropped: a redeploy mid-flight, a transient 500, a network
--    blip. When one was lost the deposit sat 'pending' forever — the player had
--    paid and was never credited, and nothing in the system noticed.
--
--    Withdrawals always had a reconciler. Deposits did not. That asymmetry was
--    the only remaining path where a player could lose real money.
--
--    Three independent paths now credit a deposit, and all of them converge on
--    the same idempotent credit_deposit():
--
--      a. the webhook          (fast path, unchanged)
--      b. returning from checkout — the player's own browser triggers a
--         verify-and-credit, which catches the common case within seconds
--      c. a sweep of anything still pending, which catches the case where the
--         player paid and closed the tab
--
--    Nothing here trusts the browser: every path re-verifies the charge against
--    Flutterwave's API and credits the amount THEY report.
-- ============================================================================

-- ---------------------------------------------------------------- stakes

alter table public.platform_settings
  add column if not exists min_stake_kobo bigint not null default 50000,      -- ₦500
  add column if not exists max_stake_kobo bigint not null default 100000000;  -- ₦1,000,000

create or replace function public.assert_stake_allowed(p_stake bigint)
returns void
language plpgsql
stable
security definer set search_path = public
as $$
declare s public.platform_settings;
begin
  select * into s from public.platform_settings where id;
  if p_stake < s.min_stake_kobo then
    raise exception 'the smallest stake is NGN %',
      trim(to_char(s.min_stake_kobo / 100.0, '999,999,990D99'));
  end if;
  if p_stake > s.max_stake_kobo then
    raise exception 'the largest stake is NGN %',
      trim(to_char(s.max_stake_kobo / 100.0, '999,999,990D99'));
  end if;
end $$;

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
  perform public.assert_stake_allowed(p_stake);

  if public.is_self_excluded(uid) then
    raise exception 'you have excluded yourself from playing until %',
      to_char((select self_excluded_until from public.profiles where id = uid), 'DD Mon YYYY');
  end if;

  perform pg_advisory_xact_lock(hashtext('dice_duel:queue:' || p_stake::text));

  select balance_kobo into bal from public.profiles where id = uid for update;
  if bal is null then raise exception 'no profile'; end if;
  if bal < p_stake then raise exception 'insufficient balance'; end if;

  if exists (select 1 from public.matches
              where status in ('waiting','playing') and (player_a = uid or player_b = uid)) then
    raise exception 'you are already in a match';
  end if;

  select * into opponent
    from public.queue_entries q
   where q.stake_kobo = p_stake
     and q.player_id <> uid
     and exists (select 1 from public.profiles p where p.id = q.player_id and p.balance_kobo >= p_stake)
   order by q.created_at
   for update skip locked
   limit 1;

  if found then
    return public.start_match(opponent.player_id, uid, p_stake, opponent.client_seed, seed);
  end if;

  insert into public.queue_entries (player_id, stake_kobo, client_seed)
  values (uid, p_stake, seed)
  on conflict (player_id) do update set stake_kobo = excluded.stake_kobo,
                                        client_seed = excluded.client_seed,
                                        created_at = now();
  return null;
end $$;

create or replace function public.challenge_friend(
  p_friend uuid, p_stake bigint, p_client_seed text
) returns uuid
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  bal bigint;
  seed text := coalesce(nullif(trim(p_client_seed), ''), encode(extensions.gen_random_bytes(8), 'hex'));
  mid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform public.assert_stake_allowed(p_stake);

  if public.is_self_excluded(uid) then
    raise exception 'you have excluded yourself from playing';
  end if;

  if not exists (
    select 1 from public.friendships
     where status = 'accepted'
       and least(requester_id, addressee_id) = least(uid, p_friend)
       and greatest(requester_id, addressee_id) = greatest(uid, p_friend)
  ) then
    raise exception 'you can only challenge friends';
  end if;

  select balance_kobo into bal from public.profiles where id = uid;
  if bal < p_stake then raise exception 'insufficient balance'; end if;

  if exists (select 1 from public.matches
              where status in ('waiting','playing') and (player_a = uid or player_b = uid)) then
    raise exception 'you are already in a match';
  end if;

  insert into public.matches (stake_kobo, player_a, client_seed_a, server_seed_hash,
                              is_private, challenged_player, status)
  values (p_stake, uid, seed, '', true, p_friend, 'waiting')
  returning id into mid;
  return mid;
end $$;

create or replace function public.create_private_table(p_stake bigint, p_client_seed text)
returns text
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  bal bigint;
  code text;
  seed text := coalesce(nullif(trim(p_client_seed), ''), encode(extensions.gen_random_bytes(8), 'hex'));
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform public.assert_stake_allowed(p_stake);

  if public.is_self_excluded(uid) then
    raise exception 'you have excluded yourself from playing';
  end if;

  select balance_kobo into bal from public.profiles where id = uid;
  if bal < p_stake then raise exception 'insufficient balance'; end if;
  if exists (select 1 from public.matches
              where status in ('waiting','playing') and (player_a = uid or player_b = uid)) then
    raise exception 'you are already in a match';
  end if;

  loop
    select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                             1 + floor(random() * 32)::int, 1), '')
      into code
      from generate_series(1, 6);
    exit when not exists (select 1 from public.matches where invite_code = code);
  end loop;

  insert into public.matches (stake_kobo, player_a, client_seed_a, server_seed_hash,
                              is_private, invite_code, status)
  values (p_stake, uid, seed, '', true, code, 'waiting');
  return code;
end $$;

grant execute on function public.assert_stake_allowed(bigint) to authenticated;
revoke execute on function public.assert_stake_allowed(bigint) from public, anon;

-- ---------------------------------------------------------------- deposit recovery

/**
 * Deposits still pending after a grace period.
 *
 * The grace exists so we do not interrogate Flutterwave about a charge the
 * player has not finished paying yet. Anything older is worth asking about:
 * either it settled and the webhook was lost, or it never happened.
 */
create or replace function public.deposits_to_verify(
  p_older_than interval default interval '90 seconds',
  p_limit int default 50
) returns setof public.deposits
language sql
security definer set search_path = public
as $$
  select * from public.deposits
   where status = 'pending'
     and created_at < now() - p_older_than
     and created_at > now() - interval '3 days'
   order by created_at
   limit greatest(1, least(p_limit, 200));
$$;

/** A player's own pending deposits, so their browser can trigger the check. */
create or replace function public.my_pending_deposits()
returns setof public.deposits
language sql
security definer set search_path = public
as $$
  select * from public.deposits
   where player_id = auth.uid()
     and status = 'pending'
     and created_at > now() - interval '3 days'
   order by created_at desc
   limit 10;
$$;

/**
 * Give up on deposits that were never paid.
 *
 * Only ever applied to rows Flutterwave has been asked about and had no record
 * of, or that are old enough that no checkout session could still be open. This
 * marks them 'abandoned' — it never touches a balance, so a late settlement can
 * still be credited by credit_deposit(), which keys on the reference.
 */
create or replace function public.abandon_stale_deposits(
  p_older_than interval default interval '3 days'
) returns int
language plpgsql
security definer set search_path = public
as $$
declare n int;
begin
  update public.deposits
     set status = 'abandoned', updated_at = now()
   where status = 'pending' and created_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end $$;

grant execute on function public.my_pending_deposits() to authenticated;
revoke execute on function public.my_pending_deposits() from public, anon;

revoke execute on function
  public.deposits_to_verify(interval, int),
  public.abandon_stale_deposits(interval)
from public, anon, authenticated;

do $$ begin
  execute 'grant execute on function
    public.deposits_to_verify(interval, int),
    public.abandon_stale_deposits(interval)
  to service_role';
exception when undefined_object then null; end $$;
