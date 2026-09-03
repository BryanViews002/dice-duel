-- 0007_payments — part 1 of 5
-- Run the parts IN ORDER. Each is a whole number of statements, so no
-- function body is ever cut in half.

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
