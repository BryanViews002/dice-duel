-- 0007_payments — part 4 of 5
-- Run the parts IN ORDER. Each is a whole number of statements, so no
-- function body is ever cut in half.

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
