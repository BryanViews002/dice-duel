-- 0006_naira — part 1 of 3
-- Run the parts IN ORDER. Each is a whole number of statements, so no
-- function body is ever cut in half.

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
