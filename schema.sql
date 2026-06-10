-- ============================================================
-- BrightMind Athletics — Database Schema
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================

-- ----------------------------------------------------------------
-- PROFILES: one row per user, created automatically on signup.
-- Holds role, consent, and streak state.
-- ----------------------------------------------------------------
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
