-- ============================================================================
-- Pre-launch reset of synthetic balances, plus payout accounts that can
-- actually be saved.
--
-- 1. PHANTOM MONEY
--
--    Balances in this database were never real. They came from three places,
--    all of them artificial:
--
--      * 'signup'  — 10000 minor units handed to every account before 0006,
--                    when they were play chips ($100). After the rename to
--                    kobo they read as ₦100.00 of real Naira that nobody
--                    deposited. 14 accounts carried this, including the
--                    operator's, which is how it was noticed.
--      * 'deposit' — written by adjust_balance during testing, and once by the
--                    privilege-escalation probe that exposed the PUBLIC EXECUTE
--                    bug (that account was left holding ₦999,999.99).
--      * gameplay  — escrow/payout/refund cycling the above around.
--
--    The `deposits` table has ZERO rows with status 'successful', so no real
--    money has ever entered. Every balance is therefore synthetic and can be
--    cleared without losing anything.
--
--    The DO block below asserts that before touching a single row. If this is
--    ever run against a database where a real deposit has settled, it aborts
--    rather than wiping player funds.
--
-- 2. PAYOUT ACCOUNTS COULD NOT BE SAVED AT ALL
--
--    Saving a payout account required Flutterwave to resolve the account name.
--    TEST keys only resolve Flutterwave's own sandbox account (0690000031);
--    every real Nigerian account number returns "invalid account", which is the
--    error players were hitting.
--
--    Accounts may now be saved unverified with the name the player types. The
--    operator sees an explicit warning at payout time — and a manual bank
--    transfer displays the true account name before it is confirmed, so the
--    check still happens, by a human, at the moment money actually moves.
-- ============================================================================

-- ---------------------------------------------------------------- 1. reset

do $$
declare
  real_deposits int;
  fixed int := 0;
  removed bigint := 0;
  r record;
begin
  select count(*) into real_deposits
    from public.deposits where status = 'successful';

  if real_deposits > 0 then
    raise exception
      'Refusing to reset balances: % settled deposit(s) exist, so some balances '
      'are real money. Reconcile by hand instead.', real_deposits;
  end if;

  for r in select id, balance_kobo from public.profiles where balance_kobo <> 0 loop
    insert into public.ledger (player_id, kind, amount_kobo, balance_after_kobo)
    values (r.id, 'adjustment', -r.balance_kobo, 0);

    update public.profiles
       set balance_kobo = 0, wagering_required_kobo = 0
     where id = r.id;

    fixed := fixed + 1;
    removed := removed + r.balance_kobo;
  end loop;

  raise notice 'cleared % synthetic balances totalling % kobo', fixed, removed;
end $$;

-- Nothing hands out currency on signup any more; make that the column default too.
alter table public.profiles alter column balance_kobo set default 0;
alter table public.profiles alter column wagering_required_kobo set default 0;

-- ---------------------------------------------------------------- 2. bank accounts

alter table public.bank_accounts
  add column if not exists is_verified boolean not null default false;

comment on column public.bank_accounts.is_verified is
  'True only when the account name came back from the bank via the provider''s '
  'resolve endpoint. False means the player typed it and the operator must '
  'confirm the name in their banking app before sending.';

update public.bank_accounts set is_verified = true where verified_at is not null;

alter table public.bank_accounts alter column verified_at drop not null;
alter table public.bank_accounts alter column verified_at drop default;

/**
 * Save a payout account, verified or not.
 *
 * Kept in SQL so players still cannot write to bank_accounts directly; the
 * route only decides whether verification succeeded.
 */
create or replace function public.save_bank_account(
  p_bank_code text,
  p_bank_name text,
  p_account_number text,
  p_account_name text,
  p_verified boolean
) returns public.bank_accounts
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid(); row public.bank_accounts;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_account_number !~ '^[0-9]{10}$' then raise exception 'account numbers are 10 digits'; end if;
  if coalesce(trim(p_account_name), '') = '' then raise exception 'enter the account name'; end if;
  if coalesce(trim(p_bank_code), '') = '' then raise exception 'choose a bank'; end if;

  insert into public.bank_accounts
    (player_id, bank_code, bank_name, account_number, account_name, is_verified, verified_at)
  values
    (uid, trim(p_bank_code), trim(p_bank_name), trim(p_account_number),
     upper(trim(p_account_name)), coalesce(p_verified, false),
     case when p_verified then now() else null end)
  on conflict (player_id, bank_code, account_number) do update
    set account_name = excluded.account_name,
        bank_name    = excluded.bank_name,
        is_verified  = excluded.is_verified,
        verified_at  = excluded.verified_at
  returning * into row;

  return row;
end $$;

grant execute on function public.save_bank_account(text, text, text, text, boolean) to authenticated;
revoke execute on function public.save_bank_account(text, text, text, text, boolean) from public, anon;

-- ---------------------------------------------------------------- 3. operator view

-- CREATE OR REPLACE cannot add a column to a function's return type (42P13),
-- so the old signature has to go first.
drop function if exists public.admin_pending_payouts();

create function public.admin_pending_payouts()
returns table (
  reference text, status public.payout_status, username text,
  amount_kobo bigint, fee_kobo bigint, net_kobo bigint,
  account_name text, bank_name text, bank_code text, account_number text,
  is_verified boolean, requested_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
begin
  if not coalesce((select is_admin from public.profiles where id = auth.uid()), false) then
    raise exception 'not an operator';
  end if;

  return query
    select w.reference, w.status, p.username,
           w.amount_kobo, w.fee_kobo, w.net_kobo,
           b.account_name, b.bank_name, b.bank_code, b.account_number,
           b.is_verified, w.requested_at
      from public.withdrawals w
      join public.profiles p      on p.id = w.player_id
      join public.bank_accounts b on b.id = w.bank_account_id
     where w.status in ('review', 'requested', 'processing')
     order by w.requested_at;
end $$;

grant execute on function public.admin_pending_payouts() to authenticated;
revoke execute on function public.admin_pending_payouts() from public, anon;
