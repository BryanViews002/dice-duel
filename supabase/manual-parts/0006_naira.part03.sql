-- 0006_naira — part 3 of 3
-- Run the parts IN ORDER. Each is a whole number of statements, so no
-- function body is ever cut in half.

create or replace function public.roll_as(p_match_id uuid, p_player uuid)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  m public.matches; s public.seat; seed text; r public.match_rounds;
  d_a smallint[]; d_b smallint[]; sa smallint; sb smallint; outcome public.round_result;
begin
  select * into m from public.matches where id = p_match_id for update;
  if m.status <> 'playing' then return; end if;
  s := case when m.player_a = p_player then 'a' when m.player_b = p_player then 'b' else null end;
  if s is null or m.turn <> s then return; end if;

  select server_seed into seed from public.match_secrets where match_id = m.id;
  select * into r from public.match_rounds where match_id = m.id and round_no = m.round;

  if s = 'a' then
    d_a := public.fair_dice(seed, m.client_seed_a, m.client_seed_b, m.round, 'A');
    update public.match_rounds set dice_a = d_a, score_a = public.count_sixes(d_a)
     where match_id = m.id and round_no = m.round;
    update public.matches set turn = 'b', roll_deadline = now() + interval '30 seconds' where id = m.id;
    return;
  end if;

  d_b := public.fair_dice(seed, m.client_seed_a, m.client_seed_b, m.round, 'B');
  d_a := r.dice_a;
  sa := public.count_sixes(d_a); sb := public.count_sixes(d_b);
  outcome := case when sa > sb then 'A' when sb > sa then 'B' else 'TIE' end;

  update public.match_rounds set dice_b = d_b, score_b = sb, score_a = sa, result = outcome
   where match_id = m.id and round_no = m.round;

  if outcome = 'TIE' then
    if m.round >= 64 then
      perform public.adjust_balance(m.player_a, m.stake_kobo, 'refund', m.id);
      perform public.adjust_balance(m.player_b, m.stake_kobo, 'refund', m.id);
      update public.matches set status = 'void', roll_deadline = null, finished_at = now() where id = m.id;
    else
      select * into m from public.matches where id = m.id;
      perform public.deal_round(m);
    end if;
  else
    perform public.finish_match(m.id, lower(outcome::text)::public.seat);
  end if;
end $$;

-- A faucet that mints real Naira has no place here.
drop function if exists public.claim_faucet();

alter table public.profiles drop column if exists last_faucet_at;

-- ---------------------------------------------------------------- stats view

create or replace view public.player_stats as
with played as (
  select m.id, m.stake_kobo, m.payout_kobo,
         case when m.winner = 'a' then m.player_a else m.player_b end as winner_id,
         case when m.winner = 'a' then m.player_b else m.player_a end as loser_id
    from public.matches m
   where m.status = 'finished' and m.winner is not null
),
wins as (
  select winner_id, count(*) as wins,
         sum(payout_kobo - stake_kobo) as won_kobo,
         max(payout_kobo) as biggest_pot
    from played group by winner_id
),
losses as (
  select loser_id, count(*) as losses, sum(stake_kobo) as lost_kobo
    from played group by loser_id
)
select
  p.id, p.username, p.avatar_seed,
  coalesce(w.wins, 0)                          as wins,
  coalesce(l.losses, 0)                        as losses,
  coalesce(w.wins, 0) + coalesce(l.losses, 0)  as played,
  case when coalesce(w.wins, 0) + coalesce(l.losses, 0) = 0 then 0
       else round(100.0 * coalesce(w.wins, 0) / (coalesce(w.wins, 0) + coalesce(l.losses, 0)), 1)
  end                                          as win_pct,
  coalesce(w.won_kobo, 0) - coalesce(l.lost_kobo, 0) as profit_kobo,
  coalesce(w.biggest_pot, 0)                   as biggest_pot_kobo
from public.profiles p
left join wins   w on w.winner_id = p.id
left join losses l on l.loser_id  = p.id;

grant select on public.player_stats to anon, authenticated;

grant execute on function public.join_queue(bigint, text), public.roll(uuid) to authenticated;
