-- ============================================================================
-- Minimum stake raised to ₦2,000 per player.
--
-- Each side posts ₦2,000, so the smallest pot is ₦4,000. This matches the
-- ₦2,000 minimum deposit: the smallest deposit buys exactly one match at the
-- smallest table, and nothing below that is playable.
--
-- Enforced here rather than only in the UI. The stake buttons are a client-side
-- convenience; assert_stake_allowed() is the rule, and it is what a crafted
-- request hits.
-- ============================================================================

update public.platform_settings
   set min_stake_kobo = 200000        -- ₦2,000 per player
 where id;

-- Nobody can be left sitting in a queue at a stake that is no longer legal.
delete from public.queue_entries where stake_kobo < 200000;

-- Neither can an open private table or an unanswered challenge.
delete from public.matches
 where status = 'waiting' and player_b is null and stake_kobo < 200000;
