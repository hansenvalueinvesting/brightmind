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
-- member_last_log lets the client decay a stale streak to 0 for display.
-- Return signature changed (added member_last_log), so drop before re-create.
drop function if exists public.get_my_teams();
create or replace function public.get_my_teams()
returns table (team_id uuid, team_name text, member_id uuid, member_name text,
               member_streak int, member_last_log date)
language sql security definer set search_path = public, auth
as $$
  select t.id,
         t.name,
         u.id,
         coalesce(u.raw_user_meta_data->>'username', u.email),
         coalesce(p.streak_count, 0),
         p.last_log_date
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

-- ----------------------------------------------------------------
-- FRIENDSHIPS
-- Player ↔ player, peer to peer (no coach/parent involved). One row per
-- relationship, direction preserved so we know who sent the request:
--   status 'pending'  — requester asked, addressee hasn't answered
--   status 'accepted' — both are friends and may read each other's stats
-- A declined/cancelled request is just deleted. All mutations go through the
-- security-definer RPCs below (they resolve emails without exposing
-- auth.users); the RLS policies here cover direct reads + defence in depth.
-- Safe to re-run.
-- ----------------------------------------------------------------
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'pending',   -- 'pending' | 'accepted'
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  unique (requester_id, addressee_id)
);

create index if not exists friendships_requester_idx on public.friendships (requester_id);
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);

alter table public.friendships enable row level security;

-- Either party can see rows they're part of.
drop policy if exists "friendship - select own" on public.friendships;
create policy "friendship - select own" on public.friendships
  for select using (auth.uid() in (requester_id, addressee_id));
-- You may only create a request as its requester.
drop policy if exists "friendship - insert own" on public.friendships;
create policy "friendship - insert own" on public.friendships
  for insert with check (auth.uid() = requester_id);
-- Only the addressee accepts (flips status).
drop policy if exists "friendship - update addressee" on public.friendships;
create policy "friendship - update addressee" on public.friendships
  for update using (auth.uid() = addressee_id);
-- Either party can remove the link (unfriend / cancel / decline).
drop policy if exists "friendship - delete own" on public.friendships;
create policy "friendship - delete own" on public.friendships
  for delete using (auth.uid() in (requester_id, addressee_id));

-- Friends may read each other's logs (extra permissive SELECT, OR-combined
-- with "own logs" and the coach policy — mirrors how coaches read player logs).
drop policy if exists "friends read logs" on public.logs;
create policy "friends read logs" on public.logs
  for select using (
    exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ( (f.requester_id = auth.uid() and f.addressee_id = logs.user_id)
           or (f.addressee_id = auth.uid() and f.requester_id = logs.user_id) )
    )
  );

-- ...and each other's once-a-day sleep entries.
drop policy if exists "friends read sleep" on public.sleep_entries;
create policy "friends read sleep" on public.sleep_entries
  for select using (
    exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ( (f.requester_id = auth.uid() and f.addressee_id = sleep_entries.user_id)
           or (f.addressee_id = auth.uid() and f.requester_id = sleep_entries.user_id) )
    )
  );

-- ----------------------------------------------------------------
-- FRIENDSHIP RPCs (security definer): resolve players by email and expose
-- friend identity/streak without leaking auth.users or other people's data.
-- ----------------------------------------------------------------

-- Send a friend request by email. If the other person already sent YOU a
-- pending request, this accepts it instead of creating a duplicate.
create or replace function public.send_friend_request(p_email text)
returns table (friend_id uuid, email text, username text, status text)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid      uuid;
  v_existing text;
begin
  select u.id into v_uid from auth.users u
  where lower(u.email) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'No BrightMind account found for that email';
  end if;
  if v_uid = auth.uid() then
    raise exception 'You cannot add yourself as a friend';
  end if;

  -- Any existing link in either direction?
  select f.status into v_existing from public.friendships f
  where (f.requester_id = auth.uid() and f.addressee_id = v_uid)
     or (f.requester_id = v_uid and f.addressee_id = auth.uid())
  limit 1;

  if v_existing = 'accepted' then
    raise exception 'You are already friends';
  elsif exists (
    select 1 from public.friendships f
    where f.requester_id = v_uid and f.addressee_id = auth.uid() and f.status = 'pending'
  ) then
    -- They asked first — accept it.
    update public.friendships
      set status = 'accepted', responded_at = now()
    where requester_id = v_uid and addressee_id = auth.uid();
  elsif v_existing = 'pending' then
    raise exception 'Friend request already sent';
  else
    insert into public.friendships (requester_id, addressee_id, status)
    values (auth.uid(), v_uid, 'pending');
  end if;

  return query
    select u.id,
           u.email::text,
           (u.raw_user_meta_data->>'username'),
           (select f.status from public.friendships f
              where (f.requester_id = auth.uid() and f.addressee_id = v_uid)
                 or (f.requester_id = v_uid and f.addressee_id = auth.uid())
              limit 1)
    from auth.users u where u.id = v_uid;
end;
$$;

-- Accept (p_accept true) or decline (false) a pending request sent to you.
create or replace function public.respond_friend_request(p_requester uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if p_accept then
    update public.friendships
      set status = 'accepted', responded_at = now()
    where requester_id = p_requester and addressee_id = auth.uid() and status = 'pending';
  else
    delete from public.friendships
    where requester_id = p_requester and addressee_id = auth.uid() and status = 'pending';
  end if;
end;
$$;

-- Remove a friend, cancel a sent request, or wipe any link — either direction.
create or replace function public.remove_friend(p_friend uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  delete from public.friendships
  where (requester_id = auth.uid() and addressee_id = p_friend)
     or (requester_id = p_friend and addressee_id = auth.uid());
end;
$$;

-- The calling player's accepted friends, with identity + streak info.
create or replace function public.get_my_friends()
returns table (friend_id uuid, email text, username text, streak_count int, last_log_date date)
language sql
security definer
set search_path = public, auth
as $$
  select u.id,
         u.email::text,
         (u.raw_user_meta_data->>'username'),
         p.streak_count,
         p.last_log_date
  from public.friendships f
  join auth.users u
    on u.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  left join public.profiles p on p.id = u.id
  where f.status = 'accepted'
    and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  order by lower(coalesce(u.raw_user_meta_data->>'username', u.email));
$$;

-- Pending requests involving the caller. `direction` is 'incoming' (they asked
-- you — show Accept/Decline) or 'outgoing' (you asked — show Cancel).
create or replace function public.get_friend_requests()
returns table (other_id uuid, email text, username text, direction text, requested_at timestamptz)
language sql
security definer
set search_path = public, auth
as $$
  select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end,
         u.email::text,
         (u.raw_user_meta_data->>'username'),
         case when f.requester_id = auth.uid() then 'outgoing' else 'incoming' end,
         f.created_at
  from public.friendships f
  join auth.users u
    on u.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where f.status = 'pending'
    and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  order by f.created_at desc;
$$;

grant execute on function public.send_friend_request(text)             to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.remove_friend(uuid)                   to authenticated;
grant execute on function public.get_my_friends()                      to authenticated;
grant execute on function public.get_friend_requests()                 to authenticated;

-- ----------------------------------------------------------------
-- ADMIN DASHBOARD
-- A private, password-gated overview of EVERY user, their account
-- info + player stats, and the full relationship graph (who coaches
-- / parents / is friends with whom). Reached at the site's /admin URL.
--
-- These run `security definer` so they can read across all users
-- (bypassing RLS), and are granted to `anon` because the admin visitor
-- is typically NOT logged in. The shared password is checked INSIDE
-- each function, so the data — not just the UI — is gated: a caller
-- who doesn't send the right password gets nothing back.
--
-- NOTE: a static site can't keep a secret. The password lives in the
-- client JS (to send it here) and can be read by anyone who views
-- source; treat this as a light gate for a trusted operator's own
-- tool, not hard security. Rotate it by editing the literal in BOTH
-- this file (re-run in the SQL Editor) and js/admin.js. Safe to re-run.
-- ----------------------------------------------------------------

-- Every user: identity, role, account timestamps, and — for players —
-- aggregate stats computed across their logs and sleep entries.
create or replace function public.admin_overview(p_pass text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  result jsonb;
begin
  if p_pass is distinct from 'BingBoingChing' then
    raise exception 'Unauthorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into result from (
    select
      u.id,
      u.email::text                              as email,
      (u.raw_user_meta_data->>'username')        as username,
      coalesce(pr.role, 'player')                as role,
      u.created_at,
      u.last_sign_in_at,
      pr.consent_at,
      coalesce(pr.streak_count, 0)               as streak_count,
      pr.last_log_date,
      -- Player stats (null/zero for adults, who don't keep logs).
      (select count(*) from public.logs l where l.user_id = u.id)                                            as log_count,
      (select count(*) from public.logs l where l.user_id = u.id and l.is_match_day)                         as match_count,
      (select coalesce(sum(l.duration_minutes), 0) from public.logs l where l.user_id = u.id)                as total_minutes,
      (select max(l.log_date) from public.logs l where l.user_id = u.id)                                     as last_log,
      (select round(avg(l.confidence)::numeric, 1) from public.logs l where l.user_id = u.id and l.confidence is not null) as avg_confidence,
      (select round(avg(l.focus)::numeric, 1)      from public.logs l where l.user_id = u.id and l.focus is not null)      as avg_focus,
      (select round(avg(l.stress)::numeric, 1)     from public.logs l where l.user_id = u.id and l.stress is not null)     as avg_stress,
      (select round(avg(l.intensity)::numeric, 1)  from public.logs l where l.user_id = u.id and l.intensity is not null)  as avg_intensity,
      (select round(avg(s.sleep_hours)::numeric, 1)   from public.sleep_entries s where s.user_id = u.id and s.sleep_hours is not null)   as avg_sleep_hours,
      (select round(avg(s.sleep_quality)::numeric, 1) from public.sleep_entries s where s.user_id = u.id and s.sleep_quality is not null) as avg_sleep_quality
    from auth.users u
    left join public.profiles pr on pr.id = u.id
    order by coalesce(pr.role, 'player'),
             lower(coalesce(u.raw_user_meta_data->>'username', u.email))
  ) t;

  return result;
end;
$$;

-- The relationship graph: one node per user, plus edges for every
-- coach/parent -> player link (edge `type` is the adult's role) and
-- every accepted player <-> player friendship (`type` = 'friend').
create or replace function public.admin_relationships(p_pass text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  nodes jsonb;
  edges jsonb;
begin
  if p_pass is distinct from 'BingBoingChing' then
    raise exception 'Unauthorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(n)), '[]'::jsonb) into nodes from (
    select u.id,
           coalesce(u.raw_user_meta_data->>'username', u.email) as name,
           u.email::text                                        as email,
           coalesce(pr.role, 'player')                          as role
    from auth.users u
    left join public.profiles pr on pr.id = u.id
  ) n;

  select coalesce(jsonb_agg(row_to_json(e)), '[]'::jsonb) into edges from (
    -- Adult -> player links; the adult's role labels the edge.
    select cp.coach_id as source,
           cp.player_id as target,
           coalesce(pr.role, 'coach') as type
    from public.coach_players cp
    left join public.profiles pr on pr.id = cp.coach_id
    union all
    -- Accepted player <-> player friendships.
    select f.requester_id as source,
           f.addressee_id  as target,
           'friend'        as type
    from public.friendships f
    where f.status = 'accepted'
  ) e;

  return jsonb_build_object('nodes', nodes, 'edges', edges);
end;
$$;

grant execute on function public.admin_overview(text)      to anon, authenticated;
grant execute on function public.admin_relationships(text) to anon, authenticated;

-- ----------------------------------------------------------------
-- Training sessions — one row per completed guided training activity
-- (box breathing, winning point visualization, ghosting, …). Powers the
-- stats and 7-day breakdown at the top of the Training page. Safe to re-run.
-- ----------------------------------------------------------------
create table if not exists public.training_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  activity         text not null,               -- 'box_breathing' | 'winning_point' | 'ghosting'
  duration_seconds integer,                      -- best-effort length of the session
  completed_at     timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index if not exists training_sessions_user_time_idx
  on public.training_sessions (user_id, completed_at desc);

alter table public.training_sessions enable row level security;

-- Each user reads/writes only their own training rows.
drop policy if exists "own training - select" on public.training_sessions;
create policy "own training - select" on public.training_sessions
  for select using (auth.uid() = user_id);
drop policy if exists "own training - insert" on public.training_sessions;
create policy "own training - insert" on public.training_sessions
  for insert with check (auth.uid() = user_id);
drop policy if exists "own training - delete" on public.training_sessions;
create policy "own training - delete" on public.training_sessions
  for delete using (auth.uid() = user_id);

-- A coach/parent may read the training of players they're linked to
-- (extra permissive SELECT, combined with "own training" via OR — mirrors sleep/logs).
drop policy if exists "coach reads player training" on public.training_sessions;
create policy "coach reads player training" on public.training_sessions
  for select using (
    exists (
      select 1 from public.coach_players cp
      where cp.coach_id = auth.uid() and cp.player_id = training_sessions.user_id
    )
  );
