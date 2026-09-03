-- ============================================================================
-- Switch the platform from USD play chips to real Naira.
--
-- TWO THINGS HAPPEN HERE, AND BOTH MATTER.
--
-- 1. UNITS ARE RENAMED, NOT REINTERPRETED.
--
--    Every `*_cents` column becomes `*_kobo`. Leaving a column called
--    balance_cents holding kobo would be a live hazard: Flutterwave's transfer
--    API takes NAIRA (major units, e.g. 2500.00) while everything in here is
--    minor units (250000). The unit boundary has to be obvious at every call
--    site or someone eventually pays out 100x. There is exactly one place that
--    converts, and it is named so you cannot miss it (see 0007).
--
--    1 naira = 100 kobo. Storage stays bigint minor units — never floats.
--
-- 2. THE HOUSE STOPS GIVING MONEY AWAY.
--
--    Play chips could be handed out freely. Real Naira cannot:
--      - new accounts now open at ZERO, not a 100-unit gift
--      - claim_faucet() is dropped outright; a faucet that mints real currency
--        is a hole straight through the balance sheet
--    Promotional credit, if you want it later, belongs in its own table with
--    its own wagering rules — not bolted onto signup.
-- ============================================================================

-- ---------------------------------------------------------------- rename

alter table public.profiles      rename column balance_cents to balance_kobo;
alter table public.matches       rename column stake_cents   to stake_kobo;
alter table public.matches       rename column pot_cents     to pot_kobo;
alter table public.matches       rename column rake_cents    to rake_kobo;
alter table public.matches       rename column payout_cents  to payout_kobo;
alter table public.queue_entries rename column stake_cents   to stake_kobo;
alter table public.ledger        rename column amount_cents  to amount_kobo;
alter table public.ledger        rename column balance_after to balance_after_kobo;

-- New accounts start empty. Money arrives only by deposit or by winning.
alter table public.profiles alter column balance_kobo set default 0;

-- The ledger gains the money-movement kinds that 0007 will use.
alter table public.ledger drop constraint if exists ledger_kind_check;
alter table public.ledger add constraint ledger_kind_check check (
  kind in (
    'signup', 'escrow', 'payout', 'refund', 'rake', 'faucet',   -- gameplay (legacy kinds kept for old rows)
    'deposit',            -- confirmed money in from Flutterwave
    'withdrawal_lock',    -- funds reserved the moment a payout is requested
    'withdrawal_paid',    -- payout confirmed settled; closes out the lock
    'withdrawal_refund',  -- payout definitively failed; funds returned
    'adjustment'          -- manual correction, always with a reason
  )
);

-- ---------------------------------------------------------------- functions

-- No signup bonus, and no ledger row, because nothing is credited.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  base text; candidate text; n int := 0;
begin
  base := coalesce(
    nullif(regexp_replace(lower(new.raw_user_meta_data->>'username'), '[^a-z0-9_]', '', 'g'), ''),
    nullif(regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9_]', '', 'g'), ''),
    'player'
  );
  base := left(base, 16);
  if char_length(base) < 3 then base := base || 'xyz'; end if;

  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := left(base, 15) || n::text;
  end loop;

  insert into public.profiles (id, username, balance_kobo) values (new.id, candidate, 0);
  return new;
end $$;

create or replace function public.adjust_balance(
  p_player uuid, p_amount bigint, p_kind text, p_match uuid
) returns bigint
language plpgsql
security definer set search_path = public
as $$
declare new_balance bigint;
begin
  update public.profiles
     set balance_kobo = balance_kobo + p_amount
   where id = p_player
  returning balance_kobo into new_balance;

  if new_balance is null then raise exception 'no such player %', p_player; end if;

  insert into public.ledger (player_id, match_id, kind, amount_kobo, balance_after_kobo)
  values (p_player, p_match, p_kind, p_amount, new_balance);

  return new_balance;
end $$;

create or replace function public.finish_match(p_match_id uuid, p_winner public.seat)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  m public.matches;
  pot bigint; rake bigint; payout bigint; winner_id uuid;
begin
  select * into m from public.matches where id = p_match_id;

  pot    := m.stake_kobo * 2;
  rake   := floor(pot * m.rake_bps / 10000.0);   -- rounds down; never overcharge
  payout := pot - rake;
  winner_id := case when p_winner = 'a' then m.player_a else m.player_b end;

  perform public.adjust_balance(winner_id, payout, 'payout', m.id);

  update public.matches
     set status = 'finished', winner = p_winner,
         pot_kobo = pot, rake_kobo = rake, payout_kobo = payout,
         revealed_server_seed = (select server_seed from public.match_secrets where match_id = m.id),
         roll_deadline = null, finished_at = now()
   where id = m.id;
end $$;

create or replace function public.start_match(
  p_a uuid, p_b uuid, p_stake bigint, p_seed_a text, p_seed_b text,
  p_private boolean default false, p_code text default null
) returns uuid
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  server_seed text := encode(extensions.gen_random_bytes(32), 'hex');
  mid uuid; m public.matches;
begin
  insert into public.matches (stake_kobo, player_a, player_b, client_seed_a, client_seed_b,
                              server_seed_hash, is_private, invite_code, status)
  values (p_stake, p_a, p_b, p_seed_a, p_seed_b,
          encode(extensions.digest(server_seed, 'sha256'), 'hex'), p_private, p_code, 'playing')
  returning id into mid;

  insert into public.match_secrets (match_id, server_seed) values (mid, server_seed);

  perform public.adjust_balance(p_a, -p_stake, 'escrow', mid);
  perform public.adjust_balance(p_b, -p_stake, 'escrow', mid);

  delete from public.queue_entries where player_id in (p_a, p_b);

  select * into m from public.matches where id = mid;
  perform public.deal_round(m);
  return mid;
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
  if p_stake <= 0 then raise exception 'invalid stake'; end if;

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

create or replace function public.roll(p_match_id uuid)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  m public.matches; uid uuid := auth.uid(); s public.seat; seed text; r public.match_rounds;
  d_a smallint[]; d_b smallint[]; sa smallint; sb smallint; outcome public.round_result;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into m from public.matches where id = p_match_id for update;
  if not found then raise exception 'no such match'; end if;
  if m.status <> 'playing' then raise exception 'match is not accepting rolls'; end if;

  s := case when m.player_a = uid then 'a' when m.player_b = uid then 'b' else null end;
  if s is null then raise exception 'you are not in this match'; end if;
  if m.turn <> s then raise exception 'not your turn'; end if;

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
      perform public.adjust_balance(m.player_a, m.stake_kobo, 'refund', m.id);
      perform public.adjust_balance(m.player_b, m.stake_kobo, 'refund', m.id);
      update public.matches set status = 'void', roll_deadline = null, finished_at = now() where id = m.id;
    else
      select * into m from public.matches where id = m.id;
      perform public.deal_round(m);
    end if;
  else
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
    update public.matches set turn = 'b', roll_deadline = now() + interval '30 seconds' where id = m.id;
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
      perform public.adjust_balance(m.player_a, m.stake_kobo, 'refund', m.id);
      perform public.adjust_balance(m.player_b, m.stake_kobo, 'refund', m.id);
      update public.matches set status = 'void', roll_deadline = null, finished_at = now() where id = m.id;
    else
      select * into m from public.matches where id = m.id;
      perform public.deal_round(m);
    end if;
  else
    perform public.finish_match(m.id, lower(outcome::text)::public.seat);
  end if;
end $$;

-- A faucet that mints real Naira has no place here.
drop function if exists public.claim_faucet();
alter table public.profiles drop column if exists last_faucet_at;

-- ---------------------------------------------------------------- stats view

-- CREATE OR REPLACE VIEW cannot rename an existing column: it requires the same
-- column names, types and order as the view being replaced. This definition
-- renames profit_cents -> profit_kobo and biggest_pot_cents -> biggest_pot_kobo,
-- so the old view has to go first (42P16 otherwise).
--
-- Safe to drop: player_stats holds no data of its own, nothing else depends on
-- it, and the grant is reissued at the end of this file.
drop view if exists public.player_stats;

create view public.player_stats as
with played as (
  select m.id, m.stake_kobo, m.payout_kobo,
         case when m.winner = 'a' then m.player_a else m.player_b end as winner_id,
         case when m.winner = 'a' then m.player_b else m.player_a end as loser_id
    from public.matches m
   where m.status = 'finished' and m.winner is not null
),
wins as (
  select winner_id, count(*) as wins,
         sum(payout_kobo - stake_kobo) as won_kobo,
         max(payout_kobo) as biggest_pot
    from played group by winner_id
),
losses as (
  select loser_id, count(*) as losses, sum(stake_kobo) as lost_kobo
    from played group by loser_id
)
select
  p.id, p.username, p.avatar_seed,
  coalesce(w.wins, 0)                          as wins,
  coalesce(l.losses, 0)                        as losses,
  coalesce(w.wins, 0) + coalesce(l.losses, 0)  as played,
  case when coalesce(w.wins, 0) + coalesce(l.losses, 0) = 0 then 0
       else round(100.0 * coalesce(w.wins, 0) / (coalesce(w.wins, 0) + coalesce(l.losses, 0)), 1)
  end                                          as win_pct,
  coalesce(w.won_kobo, 0) - coalesce(l.lost_kobo, 0) as profit_kobo,
  coalesce(w.biggest_pot, 0)                   as biggest_pot_kobo
from public.profiles p
left join wins   w on w.winner_id = p.id
left join losses l on l.loser_id  = p.id;

grant select on public.player_stats to anon, authenticated;
grant execute on function public.join_queue(bigint, text), public.roll(uuid) to authenticated;
