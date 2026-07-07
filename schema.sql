-- ============================================================
-- BrightMind Athletics — Database Schema
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================

-- ----------------------------------------------------------------
-- PROFILES: one row per user, created automatically on signup.
-- Holds role, consent, and streak state.
-- ----------------------------------------------------------------
-- Note: the editable username/display name is stored in Supabase Auth user
-- metadata (auth.users.raw_user_meta_data), not here — so no column is needed.
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  role          text not null default 'player',
  consent_at    timestamptz,          -- timestamp consent checkbox was accepted
  streak_count  integer not null default 0,
  last_log_date date,                 -- last calendar day a log was submitted
  created_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------
-- LOGS: one row per daily log entry.
-- All slider fields are 1-10 integers. Tournament fields are
-- nullable (only filled on a match day).
-- ----------------------------------------------------------------
create table public.logs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  log_date           date not null default current_date,

  -- Training
  session_type       text not null,
  duration_minutes   integer,         -- HH:MM stored as total minutes
  intensity          integer,
  mood_before        integer,
  mood_after         integer,
  notes              text,

  -- Mental
  confidence         integer,
  stress             integer,
  focus              integer,
  screen_time_hours  numeric(4,1),

  -- Recovery
  sleep_hours        numeric(4,1),
  sleep_quality      integer,
  soreness           integer,

  -- Match (nullable; only on match day)
  is_match_day       boolean not null default false,
  opponent_level     numeric(4,2),    -- opponent rating, e.g. 5.01
  final_score        text,            -- best-of-five games, e.g. '3-1', '0-3'
  perf_rating        integer,
  -- Legacy match columns, no longer captured by the log form (kept so old
  -- rows still read back). tournament_name / placement / emotional_state /
  -- reflection / match_type live below and via the add-column migration.
  tournament_name    text,
  placement          text,
  emotional_state    integer,
  reflection         text,

  created_at         timestamptz not null default now()
);

create index logs_user_date_idx on public.logs (user_id, log_date desc);

-- ----------------------------------------------------------------
-- ROW LEVEL SECURITY
-- This is what makes the public anon key safe: every row is locked
-- to its owner. A user can only read/write their own data.
-- ----------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.logs     enable row level security;

create policy "own profile - select" on public.profiles
  for select using (auth.uid() = id);
create policy "own profile - update" on public.profiles
  for update using (auth.uid() = id);
create policy "own profile - insert" on public.profiles
  for insert with check (auth.uid() = id);

create policy "own logs - select" on public.logs
  for select using (auth.uid() = user_id);
create policy "own logs - insert" on public.logs
  for insert with check (auth.uid() = user_id);
create policy "own logs - update" on public.logs
  for update using (auth.uid() = user_id);
-- Players may delete their own logs (drop-if-exists so this is safe to add
-- to an already-provisioned database by re-running just this statement).
drop policy if exists "own logs - delete" on public.logs;
create policy "own logs - delete" on public.logs
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------
-- AUTO-CREATE PROFILE ON SIGNUP
-- Trigger fires when a new auth.users row is created, copying the
-- role chosen at signup (passed via user metadata).
-- ----------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'role', 'player'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------
-- COACH ↔ PLAYER LINKS
-- A coach follows players (added by email) and may read their data.
-- This whole block is safe to re-run on an existing database.
-- ----------------------------------------------------------------
create table if not exists public.coach_players (
  coach_id   uuid not null references auth.users(id) on delete cascade,
  player_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (coach_id, player_id)
);

alter table public.coach_players enable row level security;

-- A coach manages only their own links.
drop policy if exists "coach - select own links" on public.coach_players;
create policy "coach - select own links" on public.coach_players
  for select using (auth.uid() = coach_id);
drop policy if exists "coach - insert own links" on public.coach_players;
create policy "coach - insert own links" on public.coach_players
  for insert with check (auth.uid() = coach_id);
drop policy if exists "coach - delete own links" on public.coach_players;
create policy "coach - delete own links" on public.coach_players
  for delete using (auth.uid() = coach_id);

-- A coach may read the logs of players they're linked to. This is an extra
-- permissive SELECT policy; it combines with the existing "own logs" one via OR.
drop policy if exists "coach reads player logs" on public.logs;
create policy "coach reads player logs" on public.logs
  for select using (
    exists (
      select 1 from public.coach_players cp
      where cp.coach_id = auth.uid() and cp.player_id = logs.user_id
    )
  );

-- ...and the profile rows of those players.
drop policy if exists "coach reads player profile" on public.profiles;
create policy "coach reads player profile" on public.profiles
  for select using (
    exists (
      select 1 from public.coach_players cp
      where cp.coach_id = auth.uid() and cp.player_id = profiles.id
    )
  );

-- ----------------------------------------------------------------
-- RPCs (security definer): resolve players by email without exposing
-- the auth.users table or other people's data to the anon client.
-- ----------------------------------------------------------------

-- Add a player/child to the calling adult's roster by email.
-- Coaches add players; parents add their children (same link table).
create or replace function public.add_player_by_email(p_email text)
returns table (player_id uuid, email text, username text)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
begin
  if coalesce((select role from public.profiles where id = auth.uid()), '') not in ('coach','parent') then
    raise exception 'Only coaches or parents can add athletes';
  end if;

  select u.id into v_uid from auth.users u
  where lower(u.email) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'No BrightMind account found for that email';
  end if;
  if v_uid = auth.uid() then
    raise exception 'You cannot add yourself as a player';
  end if;

  insert into public.coach_players (coach_id, player_id)
  values (auth.uid(), v_uid)
  on conflict do nothing;

  return query
    select u.id, u.email::text, (u.raw_user_meta_data->>'username')
    from auth.users u where u.id = v_uid;
end;
$$;

-- List the calling coach's players with identity + streak info.
create or replace function public.get_my_players()
returns table (player_id uuid, email text, username text, streak_count int, last_log_date date)
language sql
security definer
set search_path = public, auth
as $$
  select u.id,
         u.email::text,
         (u.raw_user_meta_data->>'username'),
         p.streak_count,
         p.last_log_date
  from public.coach_players cp
  join auth.users u on u.id = cp.player_id
  left join public.profiles p on p.id = cp.player_id
  where cp.coach_id = auth.uid()
  order by lower(coalesce(u.raw_user_meta_data->>'username', u.email));
$$;

grant execute on function public.add_player_by_email(text) to authenticated;
grant execute on function public.get_my_players() to authenticated;

-- ----------------------------------------------------------------
-- MATCH TYPE
-- Tournament / practice / school-league. Legacy: no longer captured by
-- the log form, but the column stays so old rows still read back.
-- ----------------------------------------------------------------
alter table public.logs add column if not exists match_type text;

-- ----------------------------------------------------------------
-- MATCH DETAILS
-- The match panel now captures just opponent level (rating), final score
-- (best-of-five games), and self-rated performance. Safe to re-run.
-- ----------------------------------------------------------------
alter table public.logs add column if not exists opponent_level numeric(4,2);
alter table public.logs add column if not exists final_score    text;

-- ----------------------------------------------------------------
-- TEAMS
-- A coach groups some of their players into named teams (School Team,
-- League Team, …). Players can see the roster (names + streak) of teams
-- they belong to. Safe to re-run.
-- ----------------------------------------------------------------
create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  coach_id   uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id    uuid not null references public.teams(id) on delete cascade,
  player_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, player_id)
);

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;

-- A coach owns and manages their own teams.
drop policy if exists "coach manages own teams" on public.teams;
create policy "coach manages own teams" on public.teams
  for all using (auth.uid() = coach_id) with check (auth.uid() = coach_id);

-- A coach manages membership of teams they own. (Player-facing reads go
-- through get_my_teams() so there's no self-referential RLS recursion.)
drop policy if exists "coach manages own team members" on public.team_members;
create policy "coach manages own team members" on public.team_members
  for all using (
    exists (select 1 from public.teams t where t.id = team_members.team_id and t.coach_id = auth.uid())
  ) with check (
    exists (select 1 from public.teams t where t.id = team_members.team_id and t.coach_id = auth.uid())
  );

-- Roster (names + streak) of every team the caller belongs to.
create or replace function public.get_my_teams()
returns table (team_id uuid, team_name text, member_id uuid, member_name text, member_streak int)
language sql security definer set search_path = public, auth
as $$
  select t.id,
         t.name,
         u.id,
         coalesce(u.raw_user_meta_data->>'username', u.email),
         coalesce(p.streak_count, 0)
  from public.team_members me
  join public.teams t        on t.id = me.team_id
  join public.team_members tm on tm.team_id = t.id
  join auth.users u          on u.id = tm.player_id
  left join public.profiles p on p.id = tm.player_id
  where me.player_id = auth.uid()
  order by t.name, lower(coalesce(u.raw_user_meta_data->>'username', u.email));
$$;

grant execute on function public.get_my_teams() to authenticated;

-- ----------------------------------------------------------------
-- RELATIONSHIP LOOKUPS
-- Let each party see who they're linked to, without exposing the
-- whole coach_players table (RLS only lets an adult read their own
-- links, so these run security definer). Safe to re-run.
-- ----------------------------------------------------------------

-- For the calling PLAYER: the coaches and parents linked to them.
create or replace function public.get_my_adults()
returns table (adult_id uuid, name text, role text)
language sql security definer set search_path = public, auth
as $$
  select u.id,
         coalesce(u.raw_user_meta_data->>'username', u.email),
         pr.role
  from public.coach_players cp
  join public.profiles pr on pr.id = cp.coach_id
  join auth.users u       on u.id = cp.coach_id
  where cp.player_id = auth.uid()
    and pr.role in ('coach', 'parent')
  order by pr.role, lower(coalesce(u.raw_user_meta_data->>'username', u.email));
$$;

-- For the calling ADULT (coach or parent): for each athlete on their
-- roster, the OTHER adults of role p_role linked to that same athlete.
-- A parent passes 'coach' to see each child's coach; a coach passes
-- 'parent' to see each player's parent.
create or replace function public.get_roster_counterparts(p_role text)
returns table (player_id uuid, adult_id uuid, adult_name text)
language sql security definer set search_path = public, auth
as $$
  select other.player_id,
         u.id,
         coalesce(u.raw_user_meta_data->>'username', u.email)
  from public.coach_players mine
  join public.coach_players other
       on other.player_id = mine.player_id
      and other.coach_id <> mine.coach_id
  join public.profiles pr on pr.id = other.coach_id and pr.role = p_role
  join auth.users u       on u.id = other.coach_id
  where mine.coach_id = auth.uid()
  order by other.player_id, lower(coalesce(u.raw_user_meta_data->>'username', u.email));
$$;

grant execute on function public.get_my_adults() to authenticated;
grant execute on function public.get_roster_counterparts(text) to authenticated;

-- ----------------------------------------------------------------
-- SLEEP ENTRIES
-- Sleep is a property of the night, not of each training session, so it
-- lives in its own table with ONE row per user per calendar day (unlike
-- logs, which has no once-a-day constraint). The unique (user_id,
-- entry_date) both enforces once-a-day and serves as the upsert conflict
-- target. Legacy sleep still sits on old logs rows; nothing is backfilled.
-- Safe to re-run.
-- ----------------------------------------------------------------
create table if not exists public.sleep_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  entry_date    date not null default current_date,
  sleep_hours   numeric(4,1),
  sleep_quality integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, entry_date)
);

create index if not exists sleep_entries_user_date_idx
  on public.sleep_entries (user_id, entry_date desc);

alter table public.sleep_entries enable row level security;

-- Each user reads/writes only their own sleep rows.
drop policy if exists "own sleep - select" on public.sleep_entries;
create policy "own sleep - select" on public.sleep_entries
  for select using (auth.uid() = user_id);
drop policy if exists "own sleep - insert" on public.sleep_entries;
create policy "own sleep - insert" on public.sleep_entries
  for insert with check (auth.uid() = user_id);
drop policy if exists "own sleep - update" on public.sleep_entries;
create policy "own sleep - update" on public.sleep_entries
  for update using (auth.uid() = user_id);
drop policy if exists "own sleep - delete" on public.sleep_entries;
create policy "own sleep - delete" on public.sleep_entries
  for delete using (auth.uid() = user_id);

-- A coach/parent may read the sleep of players they're linked to (extra
-- permissive SELECT, combined with "own sleep" via OR — mirrors logs).
drop policy if exists "coach reads player sleep" on public.sleep_entries;
create policy "coach reads player sleep" on public.sleep_entries
  for select using (
    exists (
      select 1 from public.coach_players cp
      where cp.coach_id = auth.uid() and cp.player_id = sleep_entries.user_id
    )
  );
