-- ============================================================================
-- Fix: player_stats.win_pct was NULL for anyone with a one-sided record.
--
-- THE BUG
--
-- The CASE guard coalesced, but the ELSE branch did not:
--
--   case when coalesce(w.wins,0) + coalesce(l.losses,0) = 0 then 0
--        else round(100.0 * w.wins / (w.wins + l.losses), 1) end
--
-- w and l are separate LEFT JOINs. A player who has only ever won has no row in
-- l, so l.losses is NULL, and `w.wins / (w.wins + NULL)` evaluates to NULL —
-- NULL propagates through arithmetic. Same for a player who has only ever lost,
-- via w.wins.
--
-- So the guard only caught "no matches at all". Every player with a perfect or
-- winless record fell into the ELSE and rendered a blank Win % on the
-- leaderboard. It showed a value only for players with at least one of each,
-- which is why it looked fine at a glance.
--
-- Same NULL propagation affected profit_cents: coalesce() was applied to the
-- sums, but a player with no wins row got `0 - lost` correctly while one with
-- no losses row got `won - 0` correctly, so that one happened to be safe. It is
-- made explicit below anyway rather than relying on that.
-- ============================================================================

create or replace view public.player_stats as
with played as (
  select m.id, m.stake_cents, m.payout_cents, m.finished_at,
         case when m.winner = 'a' then m.player_a else m.player_b end as winner_id,
         case when m.winner = 'a' then m.player_b else m.player_a end as loser_id
    from public.matches m
   where m.status = 'finished' and m.winner is not null
),
wins as (
  select winner_id, count(*) as wins,
         sum(payout_cents - stake_cents) as won_cents,
         max(payout_cents) as biggest_pot
    from played group by winner_id
),
losses as (
  select loser_id, count(*) as losses, sum(stake_cents) as lost_cents
    from played group by loser_id
)
select
  p.id,
  p.username,
  p.avatar_seed,
  coalesce(w.wins, 0)                          as wins,
  coalesce(l.losses, 0)                        as losses,
  coalesce(w.wins, 0) + coalesce(l.losses, 0)  as played,
  case
    when coalesce(w.wins, 0) + coalesce(l.losses, 0) = 0 then 0
    else round(
      100.0 * coalesce(w.wins, 0) / (coalesce(w.wins, 0) + coalesce(l.losses, 0)),
      1)
  end                                          as win_pct,
  coalesce(w.won_cents, 0) - coalesce(l.lost_cents, 0) as profit_cents,
  coalesce(w.biggest_pot, 0)                   as biggest_pot_cents
from public.profiles p
left join wins   w on w.winner_id = p.id
left join losses l on l.loser_id  = p.id;

grant select on public.player_stats to anon, authenticated;
