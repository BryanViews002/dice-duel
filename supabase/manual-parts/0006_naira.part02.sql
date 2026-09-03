-- 0006_naira — part 2 of 3
-- Run the parts IN ORDER. Each is a whole number of statements, so no
-- function body is ever cut in half.

create or replace function public.start_match(
  p_a uuid, p_b uuid, p_stake bigint, p_seed_a text, p_seed_b text,
  p_private boolean default false, p_code text default null
) returns uuid
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  server_seed text := encode(extensions.gen_random_bytes(32), 'hex');
  mid uuid; m public.matches;
begin
  insert into public.matches (stake_kobo, player_a, player_b, client_seed_a, client_seed_b,
                              server_seed_hash, is_private, invite_code, status)
  values (p_stake, p_a, p_b, p_seed_a, p_seed_b,
          encode(extensions.digest(server_seed, 'sha256'), 'hex'), p_private, p_code, 'playing')
  returning id into mid;

  insert into public.match_secrets (match_id, server_seed) values (mid, server_seed);

  perform public.adjust_balance(p_a, -p_stake, 'escrow', mid);
  perform public.adjust_balance(p_b, -p_stake, 'escrow', mid);

  delete from public.queue_entries where player_id in (p_a, p_b);

  select * into m from public.matches where id = mid;
  perform public.deal_round(m);
  return mid;
end $$;

create or replace function public.join_queue(p_stake bigint, p_client_seed text)
returns uuid
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  bal bigint;
  opponent public.queue_entries;
  seed text := coalesce(nullif(trim(p_client_seed), ''), encode(extensions.gen_random_bytes(8), 'hex'));
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_stake <= 0 then raise exception 'invalid stake'; end if;

  perform pg_advisory_xact_lock(hashtext('dice_duel:queue:' || p_stake::text));

  select balance_kobo into bal from public.profiles where id = uid for update;
  if bal is null then raise exception 'no profile'; end if;
  if bal < p_stake then raise exception 'insufficient balance'; end if;

  if exists (select 1 from public.matches
              where status in ('waiting','playing') and (player_a = uid or player_b = uid)) then
    raise exception 'you are already in a match';
  end if;

  select * into opponent
    from public.queue_entries q
   where q.stake_kobo = p_stake
     and q.player_id <> uid
     and exists (select 1 from public.profiles p where p.id = q.player_id and p.balance_kobo >= p_stake)
   order by q.created_at
   for update skip locked
   limit 1;

  if found then
    return public.start_match(opponent.player_id, uid, p_stake, opponent.client_seed, seed);
  end if;

  insert into public.queue_entries (player_id, stake_kobo, client_seed)
  values (uid, p_stake, seed)
  on conflict (player_id) do update set stake_kobo = excluded.stake_kobo,
                                        client_seed = excluded.client_seed,
                                        created_at = now();
  return null;
end $$;

create or replace function public.roll(p_match_id uuid)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  m public.matches; uid uuid := auth.uid(); s public.seat; seed text; r public.match_rounds;
  d_a smallint[]; d_b smallint[]; sa smallint; sb smallint; outcome public.round_result;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into m from public.matches where id = p_match_id for update;
  if not found then raise exception 'no such match'; end if;
  if m.status <> 'playing' then raise exception 'match is not accepting rolls'; end if;

  s := case when m.player_a = uid then 'a' when m.player_b = uid then 'b' else null end;
  if s is null then raise exception 'you are not in this match'; end if;
  if m.turn <> s then raise exception 'not your turn'; end if;

  select server_seed into seed from public.match_secrets where match_id = m.id;
  select * into r from public.match_rounds where match_id = m.id and round_no = m.round;

  if s = 'a' then
    d_a := public.fair_dice(seed, m.client_seed_a, m.client_seed_b, m.round, 'A');
    update public.match_rounds set dice_a = d_a, score_a = public.count_sixes(d_a)
     where match_id = m.id and round_no = m.round;
    update public.matches set turn = 'b', roll_deadline = now() + interval '30 seconds'
     where id = m.id;
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
