-- ============================================================================
-- Manual payout mode.
--
-- WHY
--
-- Flutterwave refuses POST /v3/transfers on this account ("Please enable IP
-- Whitelisting"), while GET /transfers, /transfers/fee, /banks and /balances
-- all succeed from the same whitelisted IP with the same key. That pattern is
-- an account-level payout approval, not an IP problem, and it is not something
-- code can route around. Rather than block withdrawals entirely, an operator
-- sends the money from their bank and records it here.
--
-- HOW IT TURNS ON, AND OFF
--
-- Setting platform_settings.review_threshold_kobo = 0 makes request_withdrawal
-- open EVERY payout in 'review' instead of 'requested'. That single value is
-- manual mode:
--
--   * the worker only ever claims 'requested' rows, so with nothing in that
--     state it idles harmlessly — no code change, no risk of it racing an
--     operator who is mid-transfer
--   * the reconciler only inspects 'processing', so it also has nothing to do
--
-- Raise the threshold again later and automation resumes with no deploy.
--
-- WHAT DOES NOT CHANGE
--
-- Every safety property still holds, because none of them care who moves the
-- money: funds are locked at request time, one live payout per player is
-- enforced by a unique index, settle_withdrawal is idempotent, and refunds are
-- guarded a second time by refunded_at. Marking a payout paid credits nothing —
-- the balance left when the request was made.
-- ============================================================================

-- ---------------------------------------------------------------- admin flag

alter table public.profiles
  add column if not exists is_admin boolean not null default false;

comment on column public.profiles.is_admin is
  'Operator who may settle payouts by hand. Grant sparingly: an admin can mark '
  'any payout paid or failed.';

-- ---------------------------------------------------------------- audit trail

alter table public.withdrawals
  add column if not exists marked_by uuid references public.profiles(id),
  add column if not exists manual_reference text,
  add column if not exists manual_note text;

comment on column public.withdrawals.manual_reference is
  'The bank''s own receipt/session reference for a hand-sent transfer. Required '
  'by the admin UI before a payout can be marked paid, so the operator must '
  'have the receipt in front of them rather than working from memory.';

-- ---------------------------------------------------------------- admin reads

/**
 * Payouts waiting on a human, with everything needed to send the money.
 *
 * SECURITY DEFINER because withdrawals and bank_accounts are own-row-only under
 * RLS; the is_admin check below is what replaces that restriction. A non-admin
 * calling this gets an exception, not an empty list, so a mistake is loud.
 */
create or replace function public.admin_pending_payouts()
returns table (
  reference        text,
  status           public.payout_status,
  username         text,
  amount_kobo      bigint,
  fee_kobo         bigint,
  net_kobo         bigint,
  account_name     text,
  bank_name        text,
  bank_code        text,
  account_number   text,
  requested_at     timestamptz
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
           w.requested_at
      from public.withdrawals w
      join public.profiles p      on p.id = w.player_id
      join public.bank_accounts b on b.id = w.bank_account_id
     where w.status in ('review', 'requested', 'processing')
     order by w.requested_at;
end $$;

/** Recently settled payouts, so an operator can confirm what they just did. */
create or replace function public.admin_recent_payouts(p_limit int default 20)
returns table (
  reference text, status public.payout_status, username text,
  net_kobo bigint, manual_reference text, settled_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
begin
  if not coalesce((select is_admin from public.profiles where id = auth.uid()), false) then
    raise exception 'not an operator';
  end if;

  return query
    select w.reference, w.status, p.username, w.net_kobo, w.manual_reference, w.settled_at
      from public.withdrawals w
      join public.profiles p on p.id = w.player_id
     where w.status in ('paid', 'failed', 'reversed')
     order by w.settled_at desc nulls last
     limit greatest(1, least(p_limit, 100));
end $$;

-- ---------------------------------------------------------------- admin writes

/**
 * Record the outcome of a hand-sent payout.
 *
 * Delegates to settle_withdrawal, so this inherits every guarantee that is
 * already tested: idempotency, refund-exactly-once, and the refusal to accept a
 * non-terminal outcome. This function only adds the operator check and the
 * audit trail.
 *
 * p_bank_reference is REQUIRED when marking paid. That is deliberate: it forces
 * the operator to have the bank's receipt in hand. The one genuine danger in
 * manual mode is marking a payout paid that was never actually sent, and a
 * required receipt number is the cheapest guard against it.
 */
create or replace function public.admin_settle_payout(
  p_reference      text,
  p_outcome        public.payout_status,
  p_bank_reference text default null,
  p_note           text default null
) returns text
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  result text;
begin
  if not coalesce((select is_admin from public.profiles where id = uid), false) then
    raise exception 'not an operator';
  end if;

  if p_outcome not in ('paid', 'failed') then
    raise exception 'a payout may only be marked paid or failed by hand';
  end if;

  if p_outcome = 'paid' and coalesce(trim(p_bank_reference), '') = '' then
    raise exception 'enter the bank receipt reference before marking this paid';
  end if;

  -- Stamp the audit fields first so they survive even if settle reports a
  -- no-op (for example a duplicate click on an already-settled payout).
  update public.withdrawals
     set marked_by = uid,
         manual_reference = coalesce(nullif(trim(p_bank_reference), ''), manual_reference),
         manual_note = coalesce(nullif(trim(p_note), ''), manual_note),
         reviewed_by = uid,
         reviewed_at = now(),
         updated_at = now()
   where reference = p_reference;

  result := public.settle_withdrawal(
    p_reference,
    p_outcome,
    case when p_outcome = 'paid' then 'MANUAL_BANK_TRANSFER' else 'MANUAL_FAILED' end,
    coalesce(p_note, case when p_outcome = 'paid' then 'sent by operator' else 'operator marked failed' end)
  );

  return result;
end $$;

-- ---------------------------------------------------------------- grants

-- Callable by any signed-in user; the is_admin check inside is the gate. This
-- keeps the authorisation in the database next to every other check, rather
-- than trusting a route handler to remember.
revoke execute on function
  public.admin_pending_payouts(),
  public.admin_recent_payouts(int),
  public.admin_settle_payout(text, public.payout_status, text, text)
from public, anon;

grant execute on function
  public.admin_pending_payouts(),
  public.admin_recent_payouts(int),
  public.admin_settle_payout(text, public.payout_status, text, text)
to authenticated;

-- ---------------------------------------------------------------- turn it on

-- Every payout now waits for a human. This single value IS manual mode; raise
-- it again to hand payouts back to the worker.
update public.platform_settings set review_threshold_kobo = 0 where id;
