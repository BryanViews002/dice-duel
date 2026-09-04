-- ============================================================================
-- Friends, direct challenges, and presence.
--
-- Replaces the "copy a 6-character code and send it to someone" flow with
-- something a player actually uses twice: add a friend once, then challenge
-- them from a list. The invite-code path stays for people who are not
-- registered friends yet.
--
-- Everything here is realtime-first. friendships, challenges and presence are
-- all published to supabase_realtime, so a challenge appears on the other
-- player's dashboard without a refresh, the same way a dice roll does.
-- ============================================================================

-- ---------------------------------------------------------------- presence

alter table public.profiles
  add column if not exists last_seen_at timestamptz;

create index if not exists profiles_last_seen_idx on public.profiles (last_seen_at desc);

/**
 * Heartbeat. The client calls this every ~30s while the tab is open.
 *
 * Deliberately cheap and deliberately fuzzy: "online" means seen in the last 90
 * seconds, which tolerates a missed beat without flapping. Presence that lies
 * in the optimistic direction is worse than presence that lags, so the window
 * is short rather than generous.
 */
create or replace function public.touch_presence()
returns void
language sql
security definer set search_path = public
as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;

-- ---------------------------------------------------------------- friendships

do $$ begin
  create type public.friend_status as enum ('pending', 'accepted');
exception when duplicate_object then null; end $$;

create table if not exists public.friendships (
  id           uuid primary key default extensions.gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       public.friend_status not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint no_self_friending check (requester_id <> addressee_id)
);

-- One relationship per pair, in either direction. Without the second index a
-- pair could end up with two rows facing opposite ways and a UI that shows the
-- same person as both a pending request and a friend.
create unique index if not exists friendships_pair_idx
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

create index if not exists friendships_addressee_idx on public.friendships (addressee_id, status);
create index if not exists friendships_requester_idx on public.friendships (requester_id, status);

/** Send a friend request by username. */
create or replace function public.send_friend_request(p_username text)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  target uuid;
  existing public.friendships;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select id into target from public.profiles
   where lower(username) = lower(trim(p_username));
  if target is null then raise exception 'no player called %', p_username; end if;
  if target = uid then raise exception 'you cannot add yourself'; end if;

  select * into existing from public.friendships
   where least(requester_id, addressee_id) = least(uid, target)
     and greatest(requester_id, addressee_id) = greatest(uid, target);

  if found then
    if existing.status = 'accepted' then return 'already_friends'; end if;
    -- They already asked you: treat a second request as accepting theirs.
    if existing.addressee_id = uid then
      update public.friendships set status = 'accepted', responded_at = now()
       where id = existing.id;
      return 'accepted';
    end if;
    return 'already_requested';
  end if;

  insert into public.friendships (requester_id, addressee_id) values (uid, target);
  return 'requested';
end $$;

create or replace function public.respond_to_friend_request(p_id uuid, p_accept boolean)
returns text
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid(); f public.friendships;
begin
  select * into f from public.friendships where id = p_id for update;
  if not found then raise exception 'no such request'; end if;
  if f.addressee_id <> uid then raise exception 'that request is not yours to answer'; end if;
  if f.status = 'accepted' then return 'already_friends'; end if;

  if p_accept then
    update public.friendships set status = 'accepted', responded_at = now() where id = f.id;
    return 'accepted';
  end if;

  delete from public.friendships where id = f.id;
  return 'declined';
end $$;

create or replace function public.remove_friend(p_friend uuid)
returns void
language sql
security definer set search_path = public
as $$
  delete from public.friendships
   where least(requester_id, addressee_id) = least(auth.uid(), p_friend)
     and greatest(requester_id, addressee_id) = greatest(auth.uid(), p_friend);
$$;

/** Friends list with presence and a lifetime head-to-head record. */
create or replace function public.my_friends()
returns table (
  friend_id     uuid,
  username      text,
  avatar_seed   text,
  online        boolean,
  last_seen_at  timestamptz,
  wins_vs_me    bigint,
  losses_vs_me  bigint,
  in_match      boolean
)
language plpgsql
security definer set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;

  return query
  with mates as (
    select case when f.requester_id = uid then f.addressee_id else f.requester_id end as fid
      from public.friendships f
     where f.status = 'accepted' and (f.requester_id = uid or f.addressee_id = uid)
  ),
  head_to_head as (
    select
      case when m.player_a = uid then m.player_b else m.player_a end as fid,
      count(*) filter (
        where (m.winner = 'a' and m.player_a <> uid) or (m.winner = 'b' and m.player_b <> uid)
      ) as their_wins,
      count(*) filter (
        where (m.winner = 'a' and m.player_a = uid) or (m.winner = 'b' and m.player_b = uid)
      ) as my_wins
      from public.matches m
     where m.status = 'finished' and (m.player_a = uid or m.player_b = uid)
     group by 1
  )
  select p.id, p.username, p.avatar_seed,
         (p.last_seen_at > now() - interval '90 seconds') as online,
         p.last_seen_at,
         coalesce(h.their_wins, 0),
         coalesce(h.my_wins, 0),
         exists (select 1 from public.matches mm
                  where mm.status = 'playing' and (mm.player_a = p.id or mm.player_b = p.id))
    from mates
    join public.profiles p on p.id = mates.fid
    left join head_to_head h on h.fid = mates.fid
   order by (p.last_seen_at > now() - interval '90 seconds') desc, p.username;
end $$;

/** Friend requests waiting on me. */
create or replace function public.my_friend_requests()
returns table (id uuid, requester_id uuid, username text, avatar_seed text, created_at timestamptz)
language plpgsql
security definer set search_path = public
as $$
begin
  return query
    select f.id, f.requester_id, p.username, p.avatar_seed, f.created_at
      from public.friendships f
      join public.profiles p on p.id = f.requester_id
     where f.addressee_id = auth.uid() and f.status = 'pending'
     order by f.created_at desc;
end $$;

-- ---------------------------------------------------------------- challenges

-- A private match aimed at one specific player, with no code to pass around.
alter table public.matches
  add column if not exists challenged_player uuid references public.profiles(id);

create index if not exists matches_challenged_idx
  on public.matches (challenged_player) where status = 'waiting';

/** Challenge a friend directly. Creates a waiting table only they can join. */
create or replace function public.challenge_friend(
  p_friend uuid, p_stake bigint, p_client_seed text
) returns uuid
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  bal bigint;
  seed text := coalesce(nullif(trim(p_client_seed), ''), encode(extensions.gen_random_bytes(8), 'hex'));
  mid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  if not exists (
    select 1 from public.friendships
     where status = 'accepted'
       and least(requester_id, addressee_id) = least(uid, p_friend)
       and greatest(requester_id, addressee_id) = greatest(uid, p_friend)
  ) then
    raise exception 'you can only challenge friends';
  end if;

  select balance_kobo into bal from public.profiles where id = uid;
  if bal < p_stake then raise exception 'insufficient balance'; end if;

  if exists (select 1 from public.matches
              where status in ('waiting','playing') and (player_a = uid or player_b = uid)) then
    raise exception 'you are already in a match';
  end if;

  insert into public.matches (stake_kobo, player_a, client_seed_a, server_seed_hash,
                              is_private, challenged_player, status)
  values (p_stake, uid, seed, '', true, p_friend, 'waiting')
  returning id into mid;
  return mid;
end $$;

/** Challenges aimed at me, still open. */
create or replace function public.my_challenges()
returns table (
  match_id uuid, from_id uuid, username text, avatar_seed text,
  stake_kobo bigint, created_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
begin
  return query
    select m.id, m.player_a, p.username, p.avatar_seed, m.stake_kobo, m.created_at
      from public.matches m
      join public.profiles p on p.id = m.player_a
     where m.status = 'waiting'
       and m.challenged_player = auth.uid()
       and m.player_b is null
     order by m.created_at desc;
end $$;

create or replace function public.accept_challenge(p_match uuid, p_client_seed text)
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
  select * into m from public.matches where id = p_match for update;
  if not found or m.status <> 'waiting' then raise exception 'that challenge is no longer open'; end if;
  if m.challenged_player <> uid then raise exception 'that challenge is not for you'; end if;

  select balance_kobo into bal from public.profiles where id = uid;
  if bal < m.stake_kobo then raise exception 'insufficient balance'; end if;

  -- Replaced by a real match so the seed commitment is generated once, with
  -- both client seeds already known — same reasoning as join_private_table.
  delete from public.matches where id = m.id;
  return public.start_match(m.player_a, uid, m.stake_kobo, m.client_seed_a, seed, true, null);
end $$;

create or replace function public.decline_challenge(p_match uuid)
returns void
language sql
security definer set search_path = public
as $$
  delete from public.matches
   where id = p_match and status = 'waiting' and challenged_player = auth.uid();
$$;

-- ---------------------------------------------------------------- RLS

alter table public.friendships enable row level security;

drop policy if exists friendships_read_own on public.friendships;
create policy friendships_read_own on public.friendships for select
  using (requester_id = auth.uid() or addressee_id = auth.uid());

-- A challenged player must be able to see the waiting table aimed at them,
-- which the original matches_read policy did not allow for private matches.
drop policy if exists matches_read on public.matches;
create policy matches_read on public.matches for select using (
  player_a = auth.uid()
  or player_b = auth.uid()
  or challenged_player = auth.uid()
  or status in ('finished', 'void')
  or (status = 'waiting' and not is_private)
);

grant select on public.friendships to authenticated;
revoke insert, update, delete on public.friendships from anon, authenticated;

grant execute on function
  public.touch_presence(),
  public.send_friend_request(text),
  public.respond_to_friend_request(uuid, boolean),
  public.remove_friend(uuid),
  public.my_friends(),
  public.my_friend_requests(),
  public.challenge_friend(uuid, bigint, text),
  public.my_challenges(),
  public.accept_challenge(uuid, text),
  public.decline_challenge(uuid)
to authenticated;

revoke execute on function
  public.touch_presence(),
  public.send_friend_request(text),
  public.respond_to_friend_request(uuid, boolean),
  public.remove_friend(uuid),
  public.my_friends(),
  public.my_friend_requests(),
  public.challenge_friend(uuid, bigint, text),
  public.my_challenges(),
  public.accept_challenge(uuid, text),
  public.decline_challenge(uuid)
from public, anon;

-- ---------------------------------------------------------------- realtime

do $$ begin
  alter publication supabase_realtime add table public.friendships;
exception when duplicate_object then null; end $$;
alter table public.friendships replica identity full;
