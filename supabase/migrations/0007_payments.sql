-- ============================================================================
-- Deposits and withdrawals (Flutterwave, NGN).
--
-- WHY WITHDRAWALS BREAK, AND WHAT EACH RULE HERE PREVENTS
--
-- Almost every payout bug is one of six things. The schema is shaped around
-- them deliberately:
--
--  1. DOUBLE PAYOUT. User double-clicks, or a retry fires while the first
--     request is still in flight, and two transfers leave the account.
--     -> Funds are debited at REQUEST time, and a partial unique index allows
--        at most ONE non-terminal withdrawal per player. The second request
--        cannot even be written.
--
--  2. REFUNDING A PAYOUT THAT LATER SUCCEEDS. A timeout or a PENDING status is
--     read as failure, the balance is refunded, and the transfer then settles.
--     The user keeps the money and the balance. This is the classic way an
--     operator bleeds without noticing.
--     -> ONLY the terminal states FAILED and REVERSED refund. Timeouts,
--        network errors and PENDING never do; they leave the row in
--        'processing' for the reconciler to resolve against Flutterwave.
--
--  3. DUPLICATE OR OUT-OF-ORDER WEBHOOKS. Flutterwave may deliver the same
--     event twice, or deliver 'completed' before your API call has even
--     finished writing its response.
--     -> settle_withdrawal() is idempotent: applying a terminal state to an
--        already-terminal row is a no-op that reports 'noop'. Every settlement
--        path is keyed on our own reference, not on arrival order.
--
--  4. LOST WEBHOOKS. The single most common cause of "stuck pending forever".
--     Webhooks are best-effort; they get dropped.
--     -> Nothing depends on a webhook arriving. The reconciler polls every
--        withdrawal left in 'processing' and asks Flutterwave directly. The
--        webhook is an optimisation, never the source of truth.
--
--  5. LOSING THE IDEMPOTENCY KEY ON RETRY. Generating a fresh reference when
--     retrying turns one payout into two.
--     -> `reference` is generated once, stored before the API is ever called,
--        and reused on every retry. Flutterwave rejects a duplicate reference,
--        which is the behaviour we want.
--
--  6. PAYING OUT MONEY THAT WAS NEVER REALLY THERE. Deposit, immediately
--     withdraw, charge back the deposit. Also the standard laundering route
--     through a gambling site.
--     -> Deposits add a wagering requirement that must be worked off by
--        staking before the funds become withdrawable.
--
-- UNITS: everything here is kobo (bigint). Flutterwave transfers are
-- denominated in NAIRA. The ONLY conversion lives in the TypeScript client, in
-- koboToNaira(). Do not convert anywhere else.
-- ============================================================================

-- ---------------------------------------------------------------- settings

create table if not exists public.platform_settings (
  id                        boolean primary key default true check (id),
  min_withdrawal_kobo       bigint not null default 100000,    -- ₦1,000
  max_withdrawal_kobo       bigint not null default 50000000,  -- ₦500,000
  withdrawal_fee_kobo       bigint not null default 5000,      -- ₦50 flat
  review_threshold_kobo     bigint not null default 10000000,  -- ₦100,000 -> manual review
  min_deposit_kobo          bigint not null default 50000,     -- ₦500
  wagering_multiplier_bps   int    not null default 10000,     -- 10000 = 1.0x deposit
  withdrawals_enabled       boolean not null default true,
  deposits_enabled          boolean not null default true
);
insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------- bank accounts

create table if not exists public.bank_accounts (
  id             uuid primary key default extensions.gen_random_uuid(),
  player_id      uuid not null references public.profiles(id) on delete cascade,
  bank_code      text not null,
  bank_name      text not null,
  account_number text not null check (account_number ~ '^[0-9]{10}$'),
  -- Resolved via Flutterwave's account-resolve endpoint, never typed by the
  -- user. A payout to an unresolved account is a payout into the void.
  account_name   text not null,
  verified_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (player_id, bank_code, account_number)
);

-- ---------------------------------------------------------------- deposits

do $$ begin
  create type public.deposit_status as enum ('pending', 'successful', 'failed', 'abandoned');
exception when duplicate_object then null; end $$;

create table if not exists public.deposits (
  id            uuid primary key default extensions.gen_random_uuid(),
  player_id     uuid not null references public.profiles(id) on delete cascade,
  reference     text unique not null,             -- our tx_ref, generated first
  amount_kobo   bigint not null check (amount_kobo > 0),
  status        public.deposit_status not null default 'pending',
  flw_tx_id     bigint,
  flw_status    text,
  credited_at   timestamptz,                      -- set exactly once
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists deposits_player_idx on public.deposits (player_id, created_at desc);

-- ---------------------------------------------------------------- withdrawals

do $$ begin
  create type public.payout_status as enum (
    'requested',   -- funds locked; not yet handed to Flutterwave
    'review',      -- held for a human (over threshold, or flagged)
    'processing',  -- accepted by Flutterwave; awaiting a terminal status
    'paid',        -- settled
    'failed',      -- terminal failure; funds returned
    'reversed'     -- settled then reversed by the bank; funds returned
  );
exception when duplicate_object then null; end $$;

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

-- ---------------------------------------------------------------- withdrawals API

/**
 * Request a payout. Debits immediately and returns the reference.
 *
 * Debiting here rather than on success is the whole trick: the money leaves the
 * spendable balance the instant the request exists, so it cannot be staked,
 * cannot be withdrawn again, and cannot be spent while the transfer is in
 * flight. If the payout later fails, settle_withdrawal puts it back — exactly
 * once.
 */
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
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into s from public.platform_settings where id;
  if not s.withdrawals_enabled then raise exception 'withdrawals are temporarily paused'; end if;

  -- Lock the player row for the whole check-and-debit.
  select * into p from public.profiles where id = uid for update;
  if not found then raise exception 'no profile'; end if;

  select * into acct from public.bank_accounts where id = p_bank_account_id and player_id = uid;
  if not found then raise exception 'that payout account is not yours'; end if;

  if p_amount_kobo < s.min_withdrawal_kobo then
    raise exception 'minimum withdrawal is NGN %', trim(to_char(s.min_withdrawal_kobo / 100.0, '999,999,990D99'));
  end if;
  if p_amount_kobo > s.max_withdrawal_kobo then
    raise exception 'maximum withdrawal is NGN %', trim(to_char(s.max_withdrawal_kobo / 100.0, '999,999,990D99'));
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

  -- Debit now. The CHECK (balance_kobo >= 0) aborts the transaction if this
  -- would go negative, so an over-withdrawal cannot be written at all.
  perform public.adjust_balance(uid, -p_amount_kobo, 'withdrawal_lock', null);

  insert into public.withdrawals (player_id, bank_account_id, reference,
                                  amount_kobo, fee_kobo, net_kobo, status)
  values (uid, p_bank_account_id, p_reference,
          p_amount_kobo, fee, p_amount_kobo - fee, next_status)
  returning * into w;

  return w;
end $$;

-- Server-side: mark that Flutterwave has accepted the transfer.
create or replace function public.mark_withdrawal_sent(
  p_reference text, p_flw_transfer_id bigint, p_flw_status text
) returns text
language plpgsql
security definer set search_path = public
as $$
declare w public.withdrawals;
begin
  select * into w from public.withdrawals where reference = p_reference for update;
  if not found then return 'unknown_reference'; end if;
  if w.status in ('paid','failed','reversed') then return 'noop'; end if;

  update public.withdrawals
     set status = 'processing', flw_transfer_id = p_flw_transfer_id, flw_status = p_flw_status,
         sent_at = coalesce(sent_at, now()), attempts = attempts + 1,
         last_attempt_at = now(), updated_at = now()
   where id = w.id;
  return 'processing';
end $$;

/**
 * Apply a TERMINAL outcome to a withdrawal. The only place funds are returned.
 *
 * Idempotent by design — webhooks arrive twice, out of order, and racing the
 * reconciler. Applying a terminal state to an already-terminal row reports
 * 'noop' and changes nothing.
 *
 * p_outcome must be 'paid' | 'failed' | 'reversed'. Never call this for a
 * PENDING or unknown status: that is what leaves money paid AND refunded.
 */
create or replace function public.settle_withdrawal(
  p_reference text, p_outcome public.payout_status, p_flw_status text, p_reason text
) returns text
language plpgsql
security definer set search_path = public
as $$
declare w public.withdrawals;
begin
  if p_outcome not in ('paid','failed','reversed') then
    raise exception 'settle_withdrawal only accepts terminal outcomes, got %', p_outcome;
  end if;

  select * into w from public.withdrawals where reference = p_reference for update;
  if not found then return 'unknown_reference'; end if;

  -- Already terminal. Duplicate delivery, or the reconciler and the webhook
  -- arriving together. Do nothing.
  if w.status in ('paid','failed','reversed') then
    -- One exception: a payout that settled and was later reversed by the bank.
    if not (w.status = 'paid' and p_outcome = 'reversed') then
      return 'noop';
    end if;
  end if;

  if p_outcome = 'paid' then
    update public.withdrawals
       set status = 'paid', flw_status = p_flw_status, settled_at = now(), updated_at = now()
     where id = w.id;
    -- Balance was already debited at request time; nothing more to move. The
    -- ledger row below closes the loop for auditors.
    insert into public.ledger (player_id, kind, amount_kobo, balance_after_kobo)
    select w.player_id, 'withdrawal_paid', 0, balance_kobo
      from public.profiles where id = w.player_id;
    return 'paid';
  end if;

  -- failed | reversed -> return the money, exactly once.
  if w.refunded_at is null then
    perform public.adjust_balance(w.player_id, w.amount_kobo, 'withdrawal_refund', null);
    update public.withdrawals
       set status = p_outcome, flw_status = p_flw_status, failure_reason = p_reason,
           refunded_at = now(), settled_at = now(), updated_at = now()
     where id = w.id;
    return 'refunded';
  end if;

  update public.withdrawals
     set status = p_outcome, flw_status = p_flw_status, failure_reason = p_reason, updated_at = now()
   where id = w.id;
  return 'already_refunded';
end $$;

-- Approve or reject a withdrawal sitting in review.
create or replace function public.review_withdrawal(
  p_reference text, p_approve boolean, p_reason text
) returns text
language plpgsql
security definer set search_path = public
as $$
declare w public.withdrawals;
begin
  select * into w from public.withdrawals where reference = p_reference for update;
  if not found then return 'unknown_reference'; end if;
  if w.status <> 'review' then return 'not_in_review'; end if;

  if p_approve then
    update public.withdrawals set status = 'requested', reviewed_at = now(), updated_at = now()
     where id = w.id;
    return 'approved';
  end if;

  return public.settle_withdrawal(p_reference, 'failed', 'rejected_by_operator', p_reason);
end $$;

-- Everything the reconciler needs to chase: anything non-terminal that has been
-- sitting longer than the grace period.
create or replace function public.stale_withdrawals(p_older_than interval default interval '2 minutes')
returns setof public.withdrawals
language sql
security definer set search_path = public
as $$
  select * from public.withdrawals
   where status in ('requested', 'processing')
     and requested_at < now() - p_older_than
   order by requested_at
   limit 100;
$$;

-- ---------------------------------------------------------------- wire it in

-- start_match now works the stake off each player's wagering requirement, so
-- deposited funds become withdrawable by being played rather than by sitting.
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
  perform public.apply_wagering(p_a, p_stake);
  perform public.apply_wagering(p_b, p_stake);

  delete from public.queue_entries where player_id in (p_a, p_b);

  select * into m from public.matches where id = mid;
  perform public.deal_round(m);
  return mid;
end $$;

-- ---------------------------------------------------------------- RLS

alter table public.bank_accounts      enable row level security;
alter table public.deposits           enable row level security;
alter table public.withdrawals        enable row level security;
alter table public.platform_settings  enable row level security;

drop policy if exists bank_read_own on public.bank_accounts;
create policy bank_read_own on public.bank_accounts for select using (player_id = auth.uid());

drop policy if exists deposits_read_own on public.deposits;
create policy deposits_read_own on public.deposits for select using (player_id = auth.uid());

drop policy if exists withdrawals_read_own on public.withdrawals;
create policy withdrawals_read_own on public.withdrawals for select using (player_id = auth.uid());

drop policy if exists settings_read on public.platform_settings;
create policy settings_read on public.platform_settings for select using (true);

grant select on public.bank_accounts, public.deposits, public.withdrawals,
                public.platform_settings to authenticated;
revoke insert, update, delete on public.bank_accounts, public.deposits,
                public.withdrawals, public.platform_settings from anon, authenticated;

-- Players may start a deposit and request a payout. Nothing else.
grant execute on function
  public.create_deposit(bigint, text),
  public.request_withdrawal(bigint, uuid, text),
  public.withdrawable_kobo(uuid)
to authenticated;

-- Settlement is server-only. A player who could call settle_withdrawal could
-- mark their own payout 'failed' after it succeeded and be refunded for money
-- they already have.
revoke execute on function
  public.credit_deposit(text, bigint, bigint, text),
  public.mark_withdrawal_sent(text, bigint, text),
  public.settle_withdrawal(text, public.payout_status, text, text),
  public.review_withdrawal(text, boolean, text),
  public.stale_withdrawals(interval),
  public.apply_wagering(uuid, bigint)
from anon, authenticated;

do $$ begin
  execute 'grant execute on function
    public.credit_deposit(text, bigint, bigint, text),
    public.mark_withdrawal_sent(text, bigint, text),
    public.settle_withdrawal(text, public.payout_status, text, text),
    public.review_withdrawal(text, boolean, text),
    public.stale_withdrawals(interval),
    public.apply_wagering(uuid, bigint)
  to service_role';
exception when undefined_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.withdrawals;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.deposits;
exception when duplicate_object then null; end $$;
alter table public.withdrawals replica identity full;
alter table public.deposits    replica identity full;
