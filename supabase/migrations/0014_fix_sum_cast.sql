-- ============================================================================
-- Fix: my_play_controls() failed for every player.
--
--   42804  Returned type numeric does not match expected type bigint in column 4
--
-- sum() over a bigint column returns NUMERIC, not bigint. A plpgsql function
-- using RETURN QUERY checks the row type strictly, so the declared bigint
-- columns rejected the numeric the aggregate produced. The responsible-play
-- page would have shown nothing at all.
--
-- payout_health() has the same aggregate shape. It happened to work because a
-- `language sql` function coerces the result on the way out where plpgsql will
-- not — worth casting anyway rather than relying on that difference.
-- ============================================================================

create or replace function public.my_play_controls()
returns table (
  deposit_limit_kobo          bigint,
  pending_limit_kobo          bigint,
  pending_effective_at        timestamptz,
  deposited_last_24h_kobo     bigint,
  withdrawn_last_24h_kobo     bigint,
  daily_withdrawal_limit_kobo bigint,
  self_excluded_until         timestamptz
)
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;

  return query
    select
      public.effective_deposit_limit(uid),
      p.deposit_limit_pending_kobo,
      p.deposit_limit_effective_at,
      coalesce((select sum(d.amount_kobo) from public.deposits d
                 where d.player_id = uid and d.status = 'successful'
                   and d.credited_at > now() - interval '24 hours'), 0)::bigint,
      coalesce((select sum(w.amount_kobo) from public.withdrawals w
                 where w.player_id = uid and w.requested_at > now() - interval '24 hours'
                   and w.status not in ('failed','reversed')), 0)::bigint,
      (select s.daily_withdrawal_limit_kobo from public.platform_settings s where s.id),
      p.self_excluded_until
    from public.profiles p where p.id = uid;
end $$;

create or replace function public.payout_health()
returns table (
  waiting int, oldest_minutes numeric, total_waiting_kobo bigint, breaching int
)
language sql
stable
security definer set search_path = public
as $$
  select
    count(*)::int,
    coalesce(round(max(extract(epoch from (now() - requested_at)) / 60), 1), 0)::numeric,
    coalesce(sum(net_kobo), 0)::bigint,
    count(*) filter (where requested_at < now() - interval '30 minutes')::int
  from public.withdrawals
  where status in ('review', 'requested', 'processing');
$$;

grant execute on function public.my_play_controls() to authenticated;
revoke execute on function public.my_play_controls() from public, anon;
revoke execute on function public.payout_health() from public, anon;
do $$ begin
  execute 'grant execute on function public.payout_health() to service_role, authenticated';
exception when undefined_object then null; end $$;
