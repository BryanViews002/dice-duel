-- ============================================================================
-- Transaction limits and responsible-gambling controls.
--
-- LIMITS (operator-set)
--   deposit     min ₦2,000   max ₦1,000,000 per transaction
--   withdrawal  min ₦2,000   max ₦1,000,000 per transaction
--               and ₦1,000,000 per rolling 24 hours
--
-- The daily cap counts a rolling 24 hours rather than a calendar day. A
-- calendar reset lets someone take the full limit at 23:59 and again at 00:01,
-- which is exactly the pattern a daily cap exists to prevent.
--
-- Failed and reversed payouts do NOT count toward the cap. Those were refunded,
-- so counting them would punish a player for the bank's failure.
--
-- RESPONSIBLE GAMBLING (player-set)
--   deposit limits  a player may cap their own daily deposits
--   self-exclusion  a player may lock themselves out for a period
--
-- The asymmetry in both is deliberate and is the point of the feature:
--
--   * LOWERING a deposit limit takes effect immediately.
--     RAISING one takes effect after 24 hours.
--   * Self-exclusion CANNOT be lifted early, by the player or by an operator.
--
-- A limit that can be raised in the moment of wanting to raise it protects
-- nobody. The cooling-off period is the entire mechanism.
-- ============================================================================

-- ---------------------------------------------------------------- limits

alter table public.platform_settings
  add column if not exists max_deposit_kobo bigint not null default 100000000,
  add column if not exists daily_withdrawal_limit_kobo bigint not null default 100000000;

update public.platform_settings set
  min_deposit_kobo            = 200000,      -- ₦2,000
  max_deposit_kobo            = 100000000,   -- ₦1,000,000
  min_withdrawal_kobo         = 200000,      -- ₦2,000
  max_withdrawal_kobo         = 100000000,   -- ₦1,000,000
  daily_withdrawal_limit_kobo = 100000000    -- ₦1,000,000 per rolling 24h
where id;

-- ---------------------------------------------------------------- player controls

alter table public.profiles
  add column if not exists deposit_limit_daily_kobo bigint
    check (deposit_limit_daily_kobo is null or deposit_limit_daily_kobo > 0),
  add column if not exists deposit_limit_pending_kobo bigint,
  add column if not exists deposit_limit_effective_at timestamptz,
  add column if not exists self_excluded_until timestamptz,
  add column if not exists self_excluded_at timestamptz;

comment on column public.profiles.deposit_limit_pending_kobo is
  'A requested INCREASE, held for 24h. Decreases never wait — they are applied '
  'to deposit_limit_daily_kobo immediately.';

comment on column public.profiles.self_excluded_until is
  'Hard lock. Cannot be shortened by the player or an operator; the only way '
  'out is time. Anything less is not self-exclusion.';

/** The limit in force right now, applying any increase whose 24h has elapsed. */
create or replace function public.effective_deposit_limit(p_player uuid)
returns bigint
language sql
stable
security definer set search_path = public
as $$
  select case
    when p.deposit_limit_pending_kobo is not null
     and p.deposit_limit_effective_at is not null
     and p.deposit_limit_effective_at <= now()
      then p.deposit_limit_pending_kobo
    else p.deposit_limit_daily_kobo
  end
  from public.profiles p where p.id = p_player;
$$;

/**
 * Set or clear a personal daily deposit limit.
 *
 * Lower (or first-time) limits apply at once. Raising one — including removing
 * it — is scheduled 24 hours out, because the moment a player wants a higher
 * limit is precisely the moment the limit is doing its job.
 */
create or replace function public.set_deposit_limit(p_kobo bigint)
returns text
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid(); current_limit bigint;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_kobo is not null and p_kobo <= 0 then raise exception 'enter an amount above zero'; end if;

  current_limit := public.effective_deposit_limit(uid);

  -- Tightening, or setting one for the first time: immediate.
  if current_limit is null or (p_kobo is not null and p_kobo < current_limit) then
    update public.profiles
       set deposit_limit_daily_kobo = p_kobo,
           deposit_limit_pending_kobo = null,
           deposit_limit_effective_at = null
     where id = uid;
    return 'applied';
  end if;

  -- Loosening or removing: held for 24 hours.
  update public.profiles
     set deposit_limit_pending_kobo = p_kobo,
         deposit_limit_effective_at = now() + interval '24 hours'
   where id = uid;
  return 'scheduled';
end $$;

/** Lock yourself out. Irreversible for the chosen period. */
create or replace function public.self_exclude(p_days int)
returns timestamptz
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid(); until timestamptz;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_days is null or p_days < 1 then raise exception 'choose at least one day'; end if;
  if p_days > 3650 then raise exception 'the maximum is 10 years'; end if;

  until := now() + make_interval(days => p_days);

  -- Never shorten an existing exclusion.
  update public.profiles
     set self_excluded_until = greatest(coalesce(self_excluded_until, until), until),
         self_excluded_at = coalesce(self_excluded_at, now())
   where id = uid
  returning self_excluded_until into until;

  return until;
end $$;

create or replace function public.is_self_excluded(p_player uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select self_excluded_until > now() from public.profiles where id = p_player), false);
$$;

-- ---------------------------------------------------------------- enforcement

create or replace function public.create_deposit(p_amount_kobo bigint, p_reference text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  s public.platform_settings;
  did uuid;
  cap bigint;
  spent_today bigint;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  if public.is_self_excluded(uid) then
    raise exception 'you have excluded yourself from playing until %',
      to_char((select self_excluded_until from public.profiles where id = uid), 'DD Mon YYYY');
  end if;

  select * into s from public.platform_settings where id;
  if not s.deposits_enabled then raise exception 'deposits are temporarily unavailable'; end if;

  if p_amount_kobo < s.min_deposit_kobo then
    raise exception 'the minimum deposit is NGN %',
      trim(to_char(s.min_deposit_kobo / 100.0, '999,999,990D99'));
  end if;
  if p_amount_kobo > s.max_deposit_kobo then
    raise exception 'the maximum deposit is NGN %',
      trim(to_char(s.max_deposit_kobo / 100.0, '999,999,990D99'));
  end if;

  -- The player's own daily cap, if they set one.
  cap := public.effective_deposit_limit(uid);
  if cap is not null then
    select coalesce(sum(amount_kobo), 0) into spent_today
      from public.deposits
     where player_id = uid and status = 'successful'
       and credited_at > now() - interval '24 hours';

    if spent_today + p_amount_kobo > cap then
      raise exception 'that would pass your own daily deposit limit of NGN % (NGN % used in the last 24 hours)',
        trim(to_char(cap / 100.0, '999,999,990D99')),
        trim(to_char(spent_today / 100.0, '999,999,990D99'));
    end if;
  end if;

  insert into public.deposits (player_id, reference, amount_kobo)
  values (uid, p_reference, p_amount_kobo)
  returning id into did;
  return did;
end $$;

create or replace function public.request_withdrawal(
  p_amount_kobo bigint, p_bank_account_id uuid, p_reference text
) returns public.withdrawals
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  s public.platform_settings;
  p public.profiles;
  acct public.bank_accounts;
  avail bigint;
  w public.withdrawals;
  fee bigint;
  next_status public.payout_status;
  taken_today bigint;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into s from public.platform_settings where id;
  if not s.withdrawals_enabled then raise exception 'withdrawals are temporarily paused'; end if;

  select * into p from public.profiles where id = uid for update;
  if not found then raise exception 'no profile'; end if;

  select * into acct from public.bank_accounts where id = p_bank_account_id and player_id = uid;
  if not found then raise exception 'that payout account is not yours'; end if;

  if p_amount_kobo < s.min_withdrawal_kobo then
    raise exception 'the minimum withdrawal is NGN %',
      trim(to_char(s.min_withdrawal_kobo / 100.0, '999,999,990D99'));
  end if;
  if p_amount_kobo > s.max_withdrawal_kobo then
    raise exception 'the maximum withdrawal is NGN %',
      trim(to_char(s.max_withdrawal_kobo / 100.0, '999,999,990D99'));
  end if;

  -- Rolling 24 hours, excluding anything that was refunded.
  select coalesce(sum(amount_kobo), 0) into taken_today
    from public.withdrawals
   where player_id = uid
     and requested_at > now() - interval '24 hours'
     and status not in ('failed', 'reversed');

  if taken_today + p_amount_kobo > s.daily_withdrawal_limit_kobo then
    raise exception 'that would pass the NGN % daily withdrawal limit (NGN % already requested in the last 24 hours)',
      trim(to_char(s.daily_withdrawal_limit_kobo / 100.0, '999,999,990D99')),
      trim(to_char(taken_today / 100.0, '999,999,990D99'));
  end if;

  if exists (select 1 from public.withdrawals
              where player_id = uid and status in ('requested','review','processing')) then
    raise exception 'you already have a withdrawal in progress';
  end if;

  if exists (select 1 from public.matches
              where status in ('waiting','playing') and (player_a = uid or player_b = uid)) then
    raise exception 'finish your match before withdrawing';
  end if;

  avail := public.withdrawable_kobo(uid);
  if p_amount_kobo > avail then
    if p.wagering_required_kobo > 0 then
      raise exception 'you have NGN % still to stake before that deposit can be withdrawn',
        trim(to_char(p.wagering_required_kobo / 100.0, '999,999,990D99'));
    end if;
    raise exception 'insufficient balance';
  end if;

  fee := least(s.withdrawal_fee_kobo, p_amount_kobo - 1);
  next_status := case when p_amount_kobo >= s.review_threshold_kobo then 'review' else 'requested' end;

  perform public.adjust_balance(uid, -p_amount_kobo, 'withdrawal_lock', null);

  insert into public.withdrawals (player_id, bank_account_id, reference,
                                  amount_kobo, fee_kobo, net_kobo, status)
  values (uid, p_bank_account_id, p_reference,
          p_amount_kobo, fee, p_amount_kobo - fee, next_status)
  returning * into w;

  return w;
end $$;

-- A self-excluded player cannot stake either. A block that only stops deposits
-- would still let someone play through an existing balance.
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

/** Everything the player needs to see about their own limits. */
create or replace function public.my_play_controls()
returns table (
  deposit_limit_kobo         bigint,
  pending_limit_kobo         bigint,
  pending_effective_at       timestamptz,
  deposited_last_24h_kobo    bigint,
  withdrawn_last_24h_kobo    bigint,
  daily_withdrawal_limit_kobo bigint,
  self_excluded_until        timestamptz
)
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;

  return query
    select
      public.effective_deposit_limit(uid),
      p.deposit_limit_pending_kobo,
      p.deposit_limit_effective_at,
      coalesce((select sum(amount_kobo) from public.deposits
                 where player_id = uid and status = 'successful'
                   and credited_at > now() - interval '24 hours'), 0),
      coalesce((select sum(amount_kobo) from public.withdrawals
                 where player_id = uid and requested_at > now() - interval '24 hours'
                   and status not in ('failed','reversed')), 0),
      (select s.daily_withdrawal_limit_kobo from public.platform_settings s where s.id),
      p.self_excluded_until
    from public.profiles p where p.id = uid;
end $$;

grant execute on function
  public.set_deposit_limit(bigint),
  public.self_exclude(int),
  public.my_play_controls(),
  public.effective_deposit_limit(uuid),
  public.is_self_excluded(uuid)
to authenticated;

revoke execute on function
  public.set_deposit_limit(bigint),
  public.self_exclude(int),
  public.my_play_controls(),
  public.effective_deposit_limit(uuid),
  public.is_self_excluded(uuid)
from public, anon;

-- ---------------------------------------------------------------- payout health

/**
 * Operator monitoring. Point an uptime checker at the route that wraps this and
 * you get told when payouts are ageing, instead of hearing it from a player.
 */
create or replace function public.payout_health()
returns table (
  waiting int, oldest_minutes numeric, total_waiting_kobo bigint, breaching int
)
language sql
stable
security definer set search_path = public
as $$
  select
    count(*)::int,
    coalesce(round(max(extract(epoch from (now() - requested_at)) / 60), 1), 0),
    coalesce(sum(net_kobo), 0),
    count(*) filter (where requested_at < now() - interval '30 minutes')::int
  from public.withdrawals
  where status in ('review', 'requested', 'processing');
$$;

revoke execute on function public.payout_health() from public, anon;
do $$ begin
  execute 'grant execute on function public.payout_health() to service_role, authenticated';
exception when undefined_object then null; end $$;
