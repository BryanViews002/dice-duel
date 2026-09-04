-- ============================================================================
-- Minimum stake lowered to ₦1,000 per player (smallest pot ₦2,000).
--
-- This decouples the stake floor from the ₦2,000 minimum deposit on purpose:
-- the smallest deposit now buys two matches rather than one, so a player is not
-- forced into an all-or-nothing roll to use their balance at all.
--
-- Deposit and withdrawal limits are unchanged.
-- ============================================================================

update public.platform_settings
   set min_stake_kobo = 100000        -- ₦1,000 per player
 where id;
