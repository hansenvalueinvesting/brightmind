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

  -- Tournament (nullable; only on match day)
  is_match_day       boolean not null default false,
  tournament_name    text,
  placement          text,
  perf_rating        integer,
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

-- Add a player to the calling coach's roster by email.
create or replace function public.add_player_by_email(p_email text)
returns table (player_id uuid, email text, username text)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
begin
  if coalesce((select role from public.profiles where id = auth.uid()), '') <> 'coach' then
    raise exception 'Only coaches can add players';
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
