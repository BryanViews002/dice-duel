-- ============================================================================
-- Minimum deposit lowered to ₦1,000.
--
-- It now equals the minimum stake, so the smallest deposit buys exactly one
-- match at the smallest table.
--
-- The withdrawal minimum is deliberately left at ₦2,000. Withdrawals cost a
-- ₦50 fee and, in manual mode, an operator's time on every single one — a
-- ₦1,000 payout would hand back ₦950 for the same work as a ₦100,000 one.
-- Say the word if you would rather they match.
-- ============================================================================

update public.platform_settings
   set min_deposit_kobo = 100000       -- ₦1,000
 where id;
