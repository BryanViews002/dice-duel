-- ============================================================================
-- Payout worker support.
--
-- WHY THE ARCHITECTURE CHANGED
--
-- Flutterwave gates the Transfers API behind IP whitelisting. Vercel serverless
-- egresses from a rotating pool of addresses, so there is nothing stable to
-- whitelist and every payout fails with:
--
--     400  "Please enable IP Whitelisting to access this service"
--
-- Rather than tunnel Vercel's traffic through a proxy, transfer initiation
-- moves to a small always-on worker on a host with a fixed IP. That also fixes
-- a design smell that was already there: the withdraw route made a user's HTTP
-- request block on a bank API call.
--
-- The split is now:
--
--   Next route  ->  request_withdrawal()  ->  funds locked, row is 'requested'
--                   (returns immediately; touches no third party)
--
--   Worker      ->  claim_withdrawals()   ->  rows flipped to 'processing'
--                   ->  Flutterwave /transfers
--                   ->  mark_withdrawal_sent() / settle_withdrawal()
--                   ->  and, on the same loop, reconciles anything stuck
--
-- SAFETY PROPERTIES
--
--  * claim_withdrawals uses FOR UPDATE SKIP LOCKED, so two workers running at
--    once can never claim the same row. Horizontal scaling is safe.
--
--  * A row is flipped to 'processing' BEFORE the API call. If the worker dies
--    mid-call the row is left 'processing' with no transfer id, and the
--    reconciler resolves it against Flutterwave rather than guessing.
--
--  * `reference` remains the idempotency key. Even if a row were somehow sent
--    twice, Flutterwave rejects the duplicate reference — the last line of
--    defence behind the row lock.
-- ============================================================================

/**
 * Atomically claim up to p_limit withdrawals that are ready to send.
 *
 * Returns rows already flipped to 'processing', so a crash between claiming and
 * sending leaves a row the reconciler can resolve — never one that silently
 * gets picked up and sent a second time.
 */
create or replace function public.claim_withdrawals(p_limit int default 5)
returns setof public.withdrawals
language plpgsql
security definer set search_path = public
as $$
declare r public.withdrawals; claimed public.withdrawals;
begin
  for r in
    select * from public.withdrawals
     where status = 'requested'
     order by requested_at
     for update skip locked
     limit greatest(1, least(p_limit, 25))
  loop
    update public.withdrawals
       set status = 'processing',
           attempts = attempts + 1,
           last_attempt_at = now(),
           sent_at = coalesce(sent_at, now()),
           updated_at = now()
     where id = r.id
    returning * into claimed;

    return next claimed;
  end loop;
end $$;

/**
 * Withdrawals the reconciler should chase, split by how they must be handled.
 *
 * p_status_grace  — how long a row may sit in 'processing' before we re-check
 *                   its status with Flutterwave. Short is fine; asking again is
 *                   free and changes nothing on its own.
 *
 * p_missing_grace — how long before a row with NO transfer id may be treated as
 *                   "Flutterwave never heard of this" and failed. This one is
 *                   deliberately long. If we declared a payout missing while the
 *                   POST that created it were still in flight, we would refund a
 *                   transfer that then settles, and the player keeps both. The
 *                   HTTP client aborts at 30s, so ten minutes is far beyond any
 *                   possible in-flight request, and the cost of waiting is only
 *                   that a genuinely dead payout takes longer to return.
 */
create or replace function public.withdrawals_to_reconcile(
  p_status_grace  interval default interval '90 seconds',
  p_missing_grace interval default interval '10 minutes'
) returns setof public.withdrawals
language sql
security definer set search_path = public
as $$
  select * from public.withdrawals
   where status = 'processing'
     and (
       (flw_transfer_id is not null and last_attempt_at < now() - p_status_grace)
       or
       (flw_transfer_id is null and last_attempt_at < now() - p_missing_grace)
     )
   order by requested_at
   limit 100;
$$;

/** True when a row has no transfer id and has waited out the missing-grace. */
create or replace function public.withdrawal_may_be_declared_missing(
  p_reference text, p_missing_grace interval default interval '10 minutes'
) returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (select flw_transfer_id is null and last_attempt_at < now() - p_missing_grace
       from public.withdrawals where reference = p_reference),
    false);
$$;

-- Server-side only. A player who could claim withdrawals could drive the
-- payout pipeline directly.
revoke execute on function
  public.claim_withdrawals(int),
  public.withdrawals_to_reconcile(interval, interval),
  public.withdrawal_may_be_declared_missing(text, interval)
from public, anon, authenticated;

do $$ begin
  execute 'grant execute on function
    public.claim_withdrawals(int),
    public.withdrawals_to_reconcile(interval, interval),
    public.withdrawal_may_be_declared_missing(text, interval)
  to service_role';
exception when undefined_object then null; end $$;
