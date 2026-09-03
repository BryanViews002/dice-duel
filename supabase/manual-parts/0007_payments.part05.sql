-- 0007_payments — part 5 of 5
-- Run the parts IN ORDER. Each is a whole number of statements, so no
-- function body is ever cut in half.

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
