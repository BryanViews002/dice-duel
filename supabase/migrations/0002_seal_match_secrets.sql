-- ============================================================================
-- Harden match_secrets: remove the table-level SELECT privilege entirely.
--
-- WHY THIS EXISTS
--
-- Supabase ships a default privilege rule on the public schema:
--
--   alter default privileges in schema public
--     grant all on tables to postgres, anon, authenticated, service_role;
--
-- So every table created by 0001_init.sql was automatically granted SELECT to
-- anon and authenticated, including match_secrets. 0001 never granted that
-- itself - it just never took it away.
--
-- Confirmed empirically against the live project: GET /rest/v1/match_secrets
-- with the anon key returns 200 [] rather than 401 "permission denied for
-- table match_secrets". A 200 means PostgREST was allowed to run the query and
-- RLS then filtered every row out. The seed is not currently exposed, because
-- RLS with zero policies denies all rows to non-owner roles.
--
-- But that leaves the single most sensitive value in the system - the seed that
-- determines every die before it is thrown - defended by exactly one mechanism.
-- Anyone who later adds a permissive policy for debugging, or runs
-- `alter table match_secrets disable row level security` for five minutes,
-- instantly leaks every live match's outcome to any logged-in player, who can
-- then read the dice before choosing to roll.
--
-- Revoking the privilege means PostgREST refuses the query outright, so RLS is
-- the second line of defence rather than the only one.
--
-- The game functions are unaffected: they are SECURITY DEFINER and run as the
-- owner, which is not subject to these grants.
-- ============================================================================

revoke all on public.match_secrets from anon, authenticated;

-- Stop the default-privilege rule from re-granting on any future table.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;

-- Re-assert the intended read surface explicitly, so the revoke above cannot
-- silently take away what the app legitimately needs.
grant select on
  public.profiles,
  public.matches,
  public.match_rounds,
  public.queue_entries,
  public.chat_messages,
  public.ledger,
  public.player_stats,
  public.public_profiles
to anon, authenticated;

grant update (avatar_seed) on public.profiles to authenticated;

-- Belt and braces: RLS must stay on for the sealed table.
alter table public.match_secrets enable row level security;
alter table public.match_secrets force row level security;
