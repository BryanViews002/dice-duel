-- ============================================================================
-- CRITICAL: internal functions were callable by any logged-in player.
--
-- THE BUG
--
-- PostgreSQL grants EXECUTE on every new function to the PUBLIC pseudo-role by
-- default. `anon` and `authenticated` inherit PUBLIC, so this, written in 0001
-- and repeated in 0007:
--
--     revoke execute on function public.adjust_balance(...) from anon, authenticated;
--
-- removed a grant those roles never held individually, and left the PUBLIC
-- grant — the one that actually mattered — completely intact. Every "revoke"
-- in this project was decorative.
--
-- PROVEN IMPACT (measured against the live database, not theorised):
--
--     POST /rest/v1/rpc/adjust_balance
--     { "p_player": "<own id>", "p_amount": 99999999, "p_kind": "deposit" }
--
--   with nothing but an ordinary signup token took an account from ₦0.00 to
--   ₦999,999.99. A player could mint unlimited real money, stake it, withdraw
--   it, and the ledger would look internally consistent while doing it.
--
--   Also exposed: settle_withdrawal (mark your own paid payout 'failed' and be
--   refunded cash you already hold), credit_deposit (credit an uncharged
--   deposit), and stale_withdrawals (read every player's pending payouts).
--
-- THE FIX
--
-- Revoke EXECUTE from PUBLIC — not just from anon/authenticated — then grant
-- back, explicitly, only the functions a player is meant to call. Default
-- privileges are changed too, so a function added later is locked by default
-- rather than open by default.
-- ============================================================================

-- 1. Nothing in this schema is callable by anyone, to start from.
revoke execute on all functions in schema public from public, anon, authenticated;

-- 2. Future functions are private unless explicitly granted.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- 3. The trigger that creates a profile on signup runs as the auth admin, not
--    as the player. Re-grant it so signup keeps working.
do $$ begin
  execute 'grant execute on function public.handle_new_user() to postgres, service_role, supabase_auth_admin';
exception when undefined_object then
  execute 'grant execute on function public.handle_new_user() to postgres, service_role';
end $$;

-- 4. The server needs everything, so settlement can run from route handlers.
do $$ begin
  execute 'grant execute on all functions in schema public to service_role';
exception when undefined_object then null; end $$;

-- 5. Exactly what a PLAYER may call. Anything absent here is now unreachable
--    from the browser, which is the point.
grant execute on function
  public.fair_dice(text, text, text, int, text),
  public.count_sixes(smallint[]),
  public.join_queue(bigint, text),
  public.leave_queue(),
  public.roll(uuid),
  public.claim_timeout(uuid),
  public.create_private_table(bigint, text),
  public.join_private_table(text, text),
  public.cancel_private_table(),
  public.send_chat(uuid, text, text),
  public.create_deposit(bigint, text),
  public.request_withdrawal(bigint, uuid, text),
  public.withdrawable_kobo(uuid)
to authenticated;

-- 6. withdrawable_kobo took a player id and would happily report any other
--    player's figure. Callers other than the server may only ask about
--    themselves. (service_role has a null auth.uid(), so it is unrestricted.)
create or replace function public.withdrawable_kobo(p_player uuid)
returns bigint
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if auth.uid() is not null and p_player <> auth.uid() then
    raise exception 'you can only check your own balance';
  end if;

  return greatest(
    0,
    coalesce((select balance_kobo - wagering_required_kobo
                from public.profiles where id = p_player), 0)
  );
end $$;

grant execute on function public.withdrawable_kobo(uuid) to authenticated;

-- 7. Undo the damage from the exploit probe: zero any balance that was credited
--    without a corresponding deposit, match payout or refund. On a live system
--    this should be reconciled by hand instead — it is here because this
--    database has only ever held test accounts.
with legit as (
  select player_id, sum(amount_kobo) as expected
    from public.ledger
   where kind in ('deposit','payout','refund','escrow','withdrawal_lock',
                  'withdrawal_refund','signup','faucet','adjustment')
   group by player_id
)
update public.profiles p
   set balance_kobo = greatest(0, l.expected)
  from legit l
 where l.player_id = p.id
   and p.balance_kobo <> l.expected;
