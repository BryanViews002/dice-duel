-- ============================================================================
-- Dice Duel - schema, security and game engine.
--
-- SECURITY MODEL (read this before changing anything)
--
-- The browser holds a Supabase *anon* key. Anyone can read it out of the page
-- source and call the REST API directly with their own session. Therefore:
--
--   1. No table grants any INSERT/UPDATE on balances, matches or dice.
--      Every state change goes through a SECURITY DEFINER function below,
--      which is the only code allowed to touch the money.
--   2. The server seed lives in `match_secrets`, a table with RLS enabled and
--      ZERO policies. PostgREST can never select from it. It is copied into
--      matches.revealed_server_seed only when the match is over.
--   3. Dice for a round are computed and stored the moment the round is dealt,
--      but each player's dice are only *revealed* (copied to the readable
--      columns) when that player rolls. The outcome is committed up front;
--      revealing is presentation.
--   4. profiles.balance_cents has a CHECK (>= 0). Even a logic bug cannot
--      produce a negative bankroll - the transaction aborts instead.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- types

do $$ begin
  create type public.match_status as enum ('waiting', 'playing', 'finished', 'void');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.seat as enum ('a', 'b');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.round_result as enum ('A', 'B', 'TIE');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- profiles

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null check (char_length(username) between 3 and 20),
  avatar_seed   text not null default encode(extensions.gen_random_bytes(4), 'hex'),
  balance_cents bigint not null default 10000 check (balance_cents >= 0),
  last_faucet_at timestamptz,
  created_at    timestamptz not null default now()
);

-- New auth user -> profile with a starting stack of play chips.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := coalesce(
    nullif(regexp_replace(lower(new.raw_user_meta_data->>'username'), '[^a-z0-9_]', '', 'g'), ''),
    nullif(regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9_]', '', 'g'), ''),
    'player'
  );
  base := left(base, 16);
  if char_length(base) < 3 then base := base || 'xyz'; end if;

  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := left(base, 15) || n::text;
  end loop;

  insert into public.profiles (id, username) values (new.id, candidate);
  insert into public.ledger (player_id, kind, amount_cents, balance_after)
  values (new.id, 'signup', 10000, 10000);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- matches

create table if not exists public.matches (
  id                   uuid primary key default extensions.gen_random_uuid(),
  stake_cents          bigint not null check (stake_cents > 0),
  rake_bps             int not null default 250 check (rake_bps between 0 and 1000),

  player_a             uuid not null references public.profiles(id),
  player_b             uuid references public.profiles(id),
  client_seed_a        text not null,
  client_seed_b        text,

  server_seed_hash     text not null,
  revealed_server_seed text,                       -- null until the match ends

  round                int not null default 0,
  turn                 public.seat not null default 'a',
  status               public.match_status not null default 'waiting',
  roll_deadline        timestamptz,

  is_private           boolean not null default false,
  invite_code          text unique,

  winner               public.seat,
  pot_cents            bigint,
  rake_cents           bigint,
  payout_cents         bigint,

  created_at           timestamptz not null default now(),
  finished_at          timestamptz,

  constraint different_players check (player_b is null or player_a <> player_b)
);

create index if not exists matches_open_idx  on public.matches (status, created_at desc);
create index if not exists matches_player_idx on public.matches (player_a, player_b);

-- The server seed. RLS on, no policies -> unreachable through the API.
create table if not exists public.match_secrets (
  match_id    uuid primary key references public.matches(id) on delete cascade,
  server_seed text not null
);

create table if not exists public.match_rounds (
  match_id uuid not null references public.matches(id) on delete cascade,
  round_no int not null,
  dice_a   smallint[],          -- null until player A rolls
  dice_b   smallint[],
  score_a  smallint,
  score_b  smallint,
  result   public.round_result,
  created_at timestamptz not null default now(),
  primary key (match_id, round_no)
);

create table if not exists public.queue_entries (
  player_id   uuid primary key references public.profiles(id) on delete cascade,
  stake_cents bigint not null check (stake_cents > 0),
  client_seed text not null,
  created_at  timestamptz not null default now()
);
create index if not exists queue_stake_idx on public.queue_entries (stake_cents, created_at);

create table if not exists public.chat_messages (
  id         bigserial primary key,
  match_id   uuid not null references public.matches(id) on delete cascade,
  player_id  uuid not null references public.profiles(id) on delete cascade,
  body       text check (body is null or char_length(body) between 1 and 300),
  emote      text check (emote is null or emote in ('🔥','😂','😭','🎲','👏','🧊','🤝','💀')),
  created_at timestamptz not null default now(),
  constraint body_or_emote check (num_nonnulls(body, emote) = 1)
);
create index if not exists chat_match_idx on public.chat_messages (match_id, created_at);

-- Append-only audit trail. Every cent that moves gets a row.
create table if not exists public.ledger (
  id            bigserial primary key,
  player_id     uuid not null references public.profiles(id) on delete cascade,
  match_id      uuid references public.matches(id) on delete set null,
  kind          text not null check (kind in ('signup','escrow','payout','refund','rake','faucet')),
  amount_cents  bigint not null,
  balance_after bigint not null,
  created_at    timestamptz not null default now()
);
create index if not exists ledger_player_idx on public.ledger (player_id, created_at desc);

-- ============================================================================
-- Provably fair dice - the exact same construction as the TypeScript verifier.
--
--   dice = HMAC_SHA256(key = server_seed,
--                      msg = "<seedA>:<seedB>:<round>:<role>:<counter>")
--
-- Bytes >= 252 are rejected rather than folded, so every face is exactly 1/6
-- (252 = 6 * 42). Plain `byte % 6` would quietly bias faces 1-4 upward.
-- ============================================================================

create or replace function public.fair_dice(
  p_server_seed text,
  p_client_a    text,
  p_client_b    text,
  p_round       int,
  p_role        text
) returns smallint[]
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  dice    smallint[] := '{}';
  counter int := 0;
  digest  bytea;
  b       int;
  i       int;
begin
  while coalesce(array_length(dice, 1), 0) < 2 loop
    digest := extensions.hmac(
      p_client_a || ':' || p_client_b || ':' || p_round::text || ':' || p_role || ':' || counter::text,
      p_server_seed,
      'sha256'
    );
    for i in 0 .. length(digest) - 1 loop
      b := get_byte(digest, i);
      if b < 252 then
        dice := dice || (((b % 6) + 1)::smallint);
        exit when coalesce(array_length(dice, 1), 0) = 2;
      end if;
    end loop;
    counter := counter + 1;
  end loop;
  return dice;
end $$;

create or replace function public.count_sixes(p_dice smallint[])
returns smallint
language sql immutable
as $$ select coalesce((select count(*) from unnest(p_dice) d where d = 6), 0)::smallint $$;

-- ---------------------------------------------------------------- money

create or replace function public.adjust_balance(
  p_player uuid, p_amount bigint, p_kind text, p_match uuid
) returns bigint
language plpgsql
security definer set search_path = public
as $$
declare new_balance bigint;
begin
  update public.profiles
     set balance_cents = balance_cents + p_amount
   where id = p_player
  returning balance_cents into new_balance;

  if new_balance is null then
    raise exception 'no such player %', p_player;
  end if;

  insert into public.ledger (player_id, match_id, kind, amount_cents, balance_after)
  values (p_player, p_match, p_kind, p_amount, new_balance);

  return new_balance;
end $$;

-- ---------------------------------------------------------------- round loop

-- Deal the next round: compute both players' dice up front, store them hidden.
create or replace function public.deal_round(p_match public.matches)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  seed text;
  next_no int := p_match.round + 1;
begin
  select server_seed into seed from public.match_secrets where match_id = p_match.id;

  insert into public.match_rounds (match_id, round_no)
  values (p_match.id, next_no)
  on conflict do nothing;

  update public.matches
     set round = next_no,
         turn = 'a',
         status = 'playing',
         roll_deadline = now() + interval '30 seconds'
   where id = p_match.id;
end $$;

-- Pay out and close a match.
create or replace function public.finish_match(p_match_id uuid, p_winner public.seat)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  m public.matches;
  pot bigint; rake bigint; payout bigint;
  winner_id uuid;
begin
  select * into m from public.matches where id = p_match_id;

  pot    := m.stake_cents * 2;
  rake   := floor(pot * m.rake_bps / 10000.0);   -- rounds down: never overcharge
  payout := pot - rake;
  winner_id := case when p_winner = 'a' then m.player_a else m.player_b end;

  perform public.adjust_balance(winner_id, payout, 'payout', m.id);

  update public.matches
     set status = 'finished',
         winner = p_winner,
         pot_cents = pot,
         rake_cents = rake,
         payout_cents = payout,
         revealed_server_seed = (select server_seed from public.match_secrets where match_id = m.id),
         roll_deadline = null,
         finished_at = now()
   where id = m.id;
end $$;

-- ---------------------------------------------------------------- public API

-- Roll for the calling player. This is the only way dice ever become visible.
create or replace function public.roll(p_match_id uuid)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  m       public.matches;
  uid     uuid := auth.uid();
  s       public.seat;
  seed    text;
  r       public.match_rounds;
  d_a smallint[]; d_b smallint[];
  sa smallint; sb smallint;
  outcome public.round_result;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  -- Serialise every roll on this match. Two concurrent calls cannot both pass.
  select * into m from public.matches where id = p_match_id for update;
  if not found then raise exception 'no such match'; end if;
  if m.status <> 'playing' then raise exception 'match is not accepting rolls'; end if;

  s := case when m.player_a = uid then 'a'
            when m.player_b = uid then 'b'
            else null end;
  if s is null then raise exception 'you are not in this match'; end if;
  if m.turn <> s then raise exception 'not your turn'; end if;

  select server_seed into seed from public.match_secrets where match_id = m.id;
  select * into r from public.match_rounds where match_id = m.id and round_no = m.round;

  if s = 'a' then
    d_a := public.fair_dice(seed, m.client_seed_a, m.client_seed_b, m.round, 'A');
    update public.match_rounds
       set dice_a = d_a, score_a = public.count_sixes(d_a)
     where match_id = m.id and round_no = m.round;

    update public.matches
       set turn = 'b', roll_deadline = now() + interval '30 seconds'
     where id = m.id;
    return;
  end if;

  -- Player B rolls: the round resolves in this same transaction, so there is
  -- no window in which a second roll could re-settle it.
  d_b := public.fair_dice(seed, m.client_seed_a, m.client_seed_b, m.round, 'B');
  d_a := r.dice_a;
  sa := public.count_sixes(d_a);
  sb := public.count_sixes(d_b);
  outcome := case when sa > sb then 'A' when sb > sa then 'B' else 'TIE' end;

  update public.match_rounds
     set dice_b = d_b, score_b = sb, score_a = sa, result = outcome
   where match_id = m.id and round_no = m.round;

  if outcome = 'TIE' then
    if m.round >= 64 then
      -- Astronomically unlikely (0.56^64). Refund rather than loop forever.
      perform public.adjust_balance(m.player_a, m.stake_cents, 'refund', m.id);
      perform public.adjust_balance(m.player_b, m.stake_cents, 'refund', m.id);
      update public.matches set status = 'void', roll_deadline = null, finished_at = now()
       where id = m.id;
    else
      select * into m from public.matches where id = m.id;
      perform public.deal_round(m);
    end if;
  else
    -- round_result ('A'/'B') -> seat ('a'/'b'). Postgres has no implicit cast
    -- between distinct enum types, so this conversion is required.
    perform public.finish_match(m.id, lower(outcome::text)::public.seat);
  end if;
end $$;

-- A player who stalls past the deadline can be rolled for by their opponent.
create or replace function public.claim_timeout(p_match_id uuid)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare m public.matches; uid uuid := auth.uid();
begin
  select * into m from public.matches where id = p_match_id for update;
  if not found or m.status <> 'playing' then raise exception 'match is not live'; end if;
  if uid not in (m.player_a, coalesce(m.player_b, m.player_a)) then
    raise exception 'you are not in this match';
  end if;
  if m.roll_deadline is null or now() < m.roll_deadline then
    raise exception 'the clock has not run out yet';
  end if;

  -- Roll on the stalling player's behalf. Their dice were already committed,
  -- so this cannot change the outcome - it only stops the match hanging.
  perform public.roll_as(p_match_id, case when m.turn = 'a' then m.player_a else m.player_b end);
end $$;

-- Internal variant of roll() that acts for a given player id.
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
      perform public.adjust_balance(m.player_a, m.stake_cents, 'refund', m.id);
      perform public.adjust_balance(m.player_b, m.stake_cents, 'refund', m.id);
      update public.matches set status = 'void', roll_deadline = null, finished_at = now() where id = m.id;
    else
      select * into m from public.matches where id = m.id;
      perform public.deal_round(m);
    end if;
  else
    -- round_result ('A'/'B') -> seat ('a'/'b'). Postgres has no implicit cast
    -- between distinct enum types, so this conversion is required.
    perform public.finish_match(m.id, lower(outcome::text)::public.seat);
  end if;
end $$;

-- Start a match between two players. Escrows both stakes.
create or replace function public.start_match(
  p_a uuid, p_b uuid, p_stake bigint, p_seed_a text, p_seed_b text,
  p_private boolean default false, p_code text default null
) returns uuid
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  server_seed text := encode(extensions.gen_random_bytes(32), 'hex');
  mid uuid;
  m public.matches;
begin
  insert into public.matches (stake_cents, player_a, player_b, client_seed_a, client_seed_b,
                              server_seed_hash, is_private, invite_code, status)
  values (p_stake, p_a, p_b, p_seed_a, p_seed_b,
          encode(extensions.digest(server_seed, 'sha256'), 'hex'), p_private, p_code, 'playing')
  returning id into mid;

  insert into public.match_secrets (match_id, server_seed) values (mid, server_seed);

  -- Escrow. The CHECK (balance >= 0) aborts the whole transaction if either
  -- player cannot cover the stake, so a match never starts underfunded.
  perform public.adjust_balance(p_a, -p_stake, 'escrow', mid);
  perform public.adjust_balance(p_b, -p_stake, 'escrow', mid);

  delete from public.queue_entries where player_id in (p_a, p_b);

  select * into m from public.matches where id = mid;
  perform public.deal_round(m);
  return mid;
end $$;

-- Join the public queue at a stake. Returns a match id if paired immediately.
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

  select balance_cents into bal from public.profiles where id = uid for update;
  if bal < p_stake then raise exception 'insufficient balance'; end if;

  if exists (select 1 from public.matches
              where status in ('waiting','playing') and (player_a = uid or player_b = uid)) then
    raise exception 'you are already in a match';
  end if;

  -- SKIP LOCKED: two players hitting Play at the same instant cannot both
  -- claim the same opponent.
  select * into opponent
    from public.queue_entries q
   where q.stake_cents = p_stake
     and q.player_id <> uid
     and exists (select 1 from public.profiles p where p.id = q.player_id and p.balance_cents >= p_stake)
   order by q.created_at
   for update skip locked
   limit 1;

  if found then
    return public.start_match(opponent.player_id, uid, p_stake, opponent.client_seed, seed);
  end if;

  insert into public.queue_entries (player_id, stake_cents, client_seed)
  values (uid, p_stake, seed)
  on conflict (player_id) do update set stake_cents = excluded.stake_cents,
                                        client_seed = excluded.client_seed,
                                        created_at = now();
  return null;
end $$;

create or replace function public.leave_queue()
returns void
language sql
security definer set search_path = public
as $$ delete from public.queue_entries where player_id = auth.uid() $$;

-- ---------------------------------------------------------------- private tables

create or replace function public.create_private_table(p_stake bigint, p_client_seed text)
returns text
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  bal bigint;
  code text;
  seed text := coalesce(nullif(trim(p_client_seed), ''), encode(extensions.gen_random_bytes(8), 'hex'));
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select balance_cents into bal from public.profiles where id = uid;
  if bal < p_stake then raise exception 'insufficient balance'; end if;
  if exists (select 1 from public.matches
              where status in ('waiting','playing') and (player_a = uid or player_b = uid)) then
    raise exception 'you are already in a match';
  end if;

  -- Ambiguity-free alphabet: no O/0, no I/1.
  -- Note: a plpgsql assignment cannot carry a FROM clause, so this has to be
  -- SELECT ... INTO rather than `code := string_agg(...) from ...`.
  loop
    select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                             1 + floor(random() * 32)::int, 1), '')
      into code
      from generate_series(1, 6);
    exit when not exists (select 1 from public.matches where invite_code = code);
  end loop;

  insert into public.matches (stake_cents, player_a, client_seed_a, server_seed_hash,
                              is_private, invite_code, status)
  values (p_stake, uid, seed, '', true, code, 'waiting');
  return code;
end $$;

create or replace function public.join_private_table(p_code text, p_client_seed text)
returns uuid
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  m public.matches;
  bal bigint;
  seed text := coalesce(nullif(trim(p_client_seed), ''), encode(extensions.gen_random_bytes(8), 'hex'));
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into m from public.matches
   where invite_code = upper(trim(p_code)) and status = 'waiting'
   for update;
  if not found then raise exception 'no open table with that code'; end if;
  if m.player_a = uid then raise exception 'that is your own table'; end if;

  select balance_cents into bal from public.profiles where id = uid;
  if bal < m.stake_cents then raise exception 'insufficient balance'; end if;

  -- The placeholder row is replaced by a real match so seeds and the seed
  -- commitment are generated once, with both client seeds already known.
  delete from public.matches where id = m.id;
  return public.start_match(m.player_a, uid, m.stake_cents, m.client_seed_a, seed, true, m.invite_code);
end $$;

create or replace function public.cancel_private_table()
returns void
language sql
security definer set search_path = public
as $$
  delete from public.matches
   where player_a = auth.uid() and status = 'waiting' and is_private and player_b is null
$$;

-- ---------------------------------------------------------------- faucet

create or replace function public.claim_faucet()
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid(); p public.profiles;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into p from public.profiles where id = uid for update;
  if p.balance_cents >= 500 then raise exception 'the faucet is for players under $5.00'; end if;
  if p.last_faucet_at is not null and p.last_faucet_at > now() - interval '12 hours' then
    raise exception 'you can top up again in %',
      age(p.last_faucet_at + interval '12 hours', now());
  end if;
  update public.profiles set last_faucet_at = now() where id = uid;
  return public.adjust_balance(uid, 2500, 'faucet', null);
end $$;

-- ---------------------------------------------------------------- chat

create or replace function public.send_chat(p_match_id uuid, p_body text, p_emote text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.matches
                  where id = p_match_id and (player_a = uid or player_b = uid)) then
    raise exception 'you are not in this match';
  end if;
  -- Rate limit: 5 messages per 10 seconds.
  if (select count(*) from public.chat_messages
       where player_id = uid and created_at > now() - interval '10 seconds') >= 5 then
    raise exception 'slow down';
  end if;
  insert into public.chat_messages (match_id, player_id, body, emote)
  values (p_match_id, uid, nullif(trim(p_body), ''), nullif(p_emote, ''));
end $$;

-- ---------------------------------------------------------------- public views

-- Identity without money. Views run with the owner's rights (security_invoker
-- is off by default), so this deliberately reaches past the own-row-only RLS
-- policy on profiles - but it can only ever project these three columns.
create or replace view public.public_profiles as
  select id, username, avatar_seed, created_at from public.profiles;

create or replace view public.player_stats as
with played as (
  select m.id, m.stake_cents, m.payout_cents, m.finished_at,
         case when m.winner = 'a' then m.player_a else m.player_b end as winner_id,
         case when m.winner = 'a' then m.player_b else m.player_a end as loser_id
    from public.matches m
   where m.status = 'finished' and m.winner is not null
)
select
  p.id,
  p.username,
  p.avatar_seed,
  coalesce(w.wins, 0)                                  as wins,
  coalesce(l.losses, 0)                                as losses,
  coalesce(w.wins, 0) + coalesce(l.losses, 0)          as played,
  case when coalesce(w.wins, 0) + coalesce(l.losses, 0) = 0 then 0
       else round(100.0 * w.wins / (w.wins + l.losses), 1) end as win_pct,
  coalesce(w.won_cents, 0) - coalesce(l.lost_cents, 0) as profit_cents,
  coalesce(w.biggest_pot, 0)                           as biggest_pot_cents
from public.profiles p
left join (
  select winner_id, count(*) wins, sum(payout_cents - stake_cents) won_cents,
         max(payout_cents) biggest_pot
    from played group by winner_id
) w on w.winner_id = p.id
left join (
  select loser_id, count(*) losses, sum(stake_cents) lost_cents
    from played group by loser_id
) l on l.loser_id = p.id;

-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.profiles       enable row level security;
alter table public.matches        enable row level security;
alter table public.match_secrets  enable row level security;  -- no policies: sealed
alter table public.match_rounds   enable row level security;
alter table public.queue_entries  enable row level security;
alter table public.chat_messages  enable row level security;
alter table public.ledger         enable row level security;

-- profiles: OWN ROW ONLY. This table holds balance_cents, so a `using (true)`
-- policy here would let any logged-in player read every rival's bankroll
-- straight off the REST API. Usernames and avatars are published separately
-- through public_profiles below, which carries no money columns.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select using (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- matches: your own, plus any finished match (public history / verifier),
-- plus open public tables so the lobby can show who is waiting.
drop policy if exists matches_read on public.matches;
create policy matches_read on public.matches for select using (
  player_a = auth.uid()
  or player_b = auth.uid()
  or status in ('finished', 'void')
  or (status = 'waiting' and not is_private)
);

drop policy if exists rounds_read on public.match_rounds;
create policy rounds_read on public.match_rounds for select using (
  exists (
    select 1 from public.matches m
     where m.id = match_id
       and (m.player_a = auth.uid() or m.player_b = auth.uid()
            or m.status in ('finished','void'))
  )
);

drop policy if exists queue_read_own on public.queue_entries;
create policy queue_read_own on public.queue_entries for select using (player_id = auth.uid());

drop policy if exists chat_read on public.chat_messages;
create policy chat_read on public.chat_messages for select using (
  exists (select 1 from public.matches m
           where m.id = match_id and (m.player_a = auth.uid() or m.player_b = auth.uid()))
);

drop policy if exists ledger_read_own on public.ledger;
create policy ledger_read_own on public.ledger for select using (player_id = auth.uid());

-- ============================================================================
-- Grants: SELECT only on tables. Every mutation goes through a function.
-- ============================================================================

grant usage on schema public to anon, authenticated;

grant select on public.profiles, public.matches, public.match_rounds,
                 public.queue_entries, public.chat_messages, public.ledger,
                 public.player_stats, public.public_profiles
  to anon, authenticated;

revoke insert, update, delete on public.profiles, public.matches, public.match_rounds,
                 public.match_secrets, public.queue_entries, public.chat_messages, public.ledger
  from anon, authenticated;

-- Supabase's default privileges on the public schema grant ALL on new tables to
-- anon and authenticated, so match_secrets would otherwise be SELECT-able at the
-- privilege level and defended only by its (deliberately empty) RLS policy set.
-- Take the privilege away so PostgREST refuses the query outright, and stop the
-- default rule re-granting it on any table added later.
revoke all on public.match_secrets from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter table public.match_secrets force row level security;

-- Only the balance owner may update their own row, and only cosmetic columns.
revoke update on public.profiles from authenticated;
grant update (avatar_seed) on public.profiles to authenticated;

grant execute on function
  public.join_queue(bigint, text),
  public.leave_queue(),
  public.roll(uuid),
  public.claim_timeout(uuid),
  public.create_private_table(bigint, text),
  public.join_private_table(text, text),
  public.cancel_private_table(),
  public.claim_faucet(),
  public.send_chat(uuid, text, text),
  public.fair_dice(text, text, text, int, text),
  public.count_sixes(smallint[])
to authenticated;

-- Internal plumbing must not be callable from the browser.
revoke execute on function
  public.start_match(uuid, uuid, bigint, text, text, boolean, text),
  public.finish_match(uuid, public.seat),
  public.deal_round(public.matches),
  public.adjust_balance(uuid, bigint, text, uuid),
  public.roll_as(uuid, uuid)
from anon, authenticated;

-- ============================================================================
-- Realtime
-- ============================================================================

do $$ begin
  alter publication supabase_realtime add table public.matches;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.match_rounds;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.chat_messages;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null; end $$;

-- Realtime needs the full old row to route DELETEs and to diff updates.
alter table public.matches      replica identity full;
alter table public.match_rounds replica identity full;
