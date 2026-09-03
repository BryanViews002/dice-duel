-- 0007_payments — part 3 of 5
-- Run the parts IN ORDER. Each is a whole number of statements, so no
-- function body is ever cut in half.

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
