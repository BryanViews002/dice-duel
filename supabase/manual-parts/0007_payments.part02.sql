-- 0007_payments — part 2 of 5
-- Run the parts IN ORDER. Each is a whole number of statements, so no
-- function body is ever cut in half.

create table if not exists public.withdrawals (
  id              uuid primary key default extensions.gen_random_uuid(),
  player_id       uuid not null references public.profiles(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id),

  -- The idempotency key. Generated once, before Flutterwave is ever called,
  -- and reused on every retry so a retry can never become a second payout.
  reference       text unique not null,

  amount_kobo     bigint not null check (amount_kobo > 0),   -- debited from the player
  fee_kobo        bigint not null default 0,
  net_kobo        bigint not null check (net_kobo > 0),      -- what reaches the bank

  status          public.payout_status not null default 'requested',
  flw_transfer_id bigint,
  flw_status      text,
  failure_reason  text,
  attempts        int not null default 0,
  last_attempt_at timestamptz,

  -- Set exactly once, by settle_withdrawal, and checked before any refund.
  -- This is the belt to the state machine's braces: even if the state machine
  -- were wrong, a second refund cannot be written.
  refunded_at     timestamptz,

  reviewed_by     uuid references public.profiles(id),
  reviewed_at     timestamptz,

  requested_at    timestamptz not null default now(),
  sent_at         timestamptz,
  settled_at      timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists withdrawals_player_idx on public.withdrawals (player_id, requested_at desc);

create index if not exists withdrawals_open_idx on public.withdrawals (status, requested_at)
  where status in ('requested', 'review', 'processing');

-- AT MOST ONE live withdrawal per player. This single index removes the entire
-- class of double-payout races before any application code runs.
create unique index if not exists withdrawals_one_live_per_player
  on public.withdrawals (player_id)
  where status in ('requested', 'review', 'processing');

-- ---------------------------------------------------------------- wagering

-- Deposited money must be staked before it can be withdrawn (see failure 6).
alter table public.profiles
  add column if not exists wagering_required_kobo bigint not null default 0
    check (wagering_required_kobo >= 0);

-- Every stake works off the requirement. Called from start_match's escrow path.
create or replace function public.apply_wagering(p_player uuid, p_staked bigint)
returns void
language sql
security definer set search_path = public
as $$
  update public.profiles
     set wagering_required_kobo = greatest(0, wagering_required_kobo - p_staked)
   where id = p_player;
$$;

-- What the player may actually take out right now.
create or replace function public.withdrawable_kobo(p_player uuid)
returns bigint
language sql
stable
security definer set search_path = public
as $$
  select greatest(
    0,
    coalesce((select balance_kobo - wagering_required_kobo from public.profiles where id = p_player), 0)
    -- Money already locked by a live withdrawal has been debited from
    -- balance_kobo already, so it is not subtracted twice here.
  );
$$;

-- ---------------------------------------------------------------- deposits API

-- Called by the player. Creates the pending row; credits nothing.
create or replace function public.create_deposit(p_amount_kobo bigint, p_reference text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid(); s public.platform_settings; did uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into s from public.platform_settings where id;
  if not s.deposits_enabled then raise exception 'deposits are temporarily unavailable'; end if;
  if p_amount_kobo < s.min_deposit_kobo then
    raise exception 'minimum deposit is %', (s.min_deposit_kobo / 100.0);
  end if;

  insert into public.deposits (player_id, reference, amount_kobo)
  values (uid, p_reference, p_amount_kobo)
  returning id into did;
  return did;
end $$;

-- Called ONLY by the server after verifying the transaction with Flutterwave.
-- Idempotent: a repeated webhook credits nothing the second time.
create or replace function public.credit_deposit(
  p_reference text, p_flw_tx_id bigint, p_verified_amount_kobo bigint, p_flw_status text
) returns text
language plpgsql
security definer set search_path = public
as $$
declare d public.deposits; s public.platform_settings; mult bigint;
begin
  select * into d from public.deposits where reference = p_reference for update;
  if not found then return 'unknown_reference'; end if;

  if d.status = 'successful' then
    return 'noop';                       -- already credited; duplicate delivery
  end if;

  if p_flw_status is distinct from 'successful' then
    update public.deposits
       set status = 'failed', flw_status = p_flw_status, flw_tx_id = p_flw_tx_id, updated_at = now()
     where id = d.id;
    return 'failed';
  end if;

  -- Never trust the amount the client asked for; credit what Flutterwave says
  -- was actually paid. A mismatch is either tampering or a partial payment.
  if p_verified_amount_kobo <> d.amount_kobo then
    update public.deposits
       set status = 'failed', flw_status = p_flw_status, flw_tx_id = p_flw_tx_id,
           updated_at = now()
     where id = d.id;
    return 'amount_mismatch';
  end if;

  select * into s from public.platform_settings where id;
  mult := (p_verified_amount_kobo * s.wagering_multiplier_bps) / 10000;

  perform public.adjust_balance(d.player_id, p_verified_amount_kobo, 'deposit', null);
  update public.profiles
     set wagering_required_kobo = wagering_required_kobo + mult
   where id = d.player_id;

  update public.deposits
     set status = 'successful', flw_tx_id = p_flw_tx_id, flw_status = p_flw_status,
         credited_at = now(), updated_at = now()
   where id = d.id;

  return 'credited';
end $$;
