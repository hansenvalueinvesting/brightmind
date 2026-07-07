# Database migrations

`schema.sql` is the source of truth for the database, but editing it does **not**
change the live Supabase database — Postgres functions/tables must be applied
manually in the Supabase SQL Editor (Dashboard → SQL Editor → New query → Run).

This file tracks changes that still need to be (or have been) applied to the live
database, so the code and the database don't silently drift apart.

Everything below is safe to re-run (`create or replace` / `grant`).

---

## 2026-07 — Player friend system

Covers: peer-to-peer friends. Players send/accept/decline friend requests, add
and remove friends, and compare stats. Adds a `friendships` table, RLS so friends
can read each other's `logs` / `sleep_entries`, and the RPCs the Friends tab uses.

Run this whole block once:

```sql
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

drop policy if exists "friendship - select own" on public.friendships;
create policy "friendship - select own" on public.friendships
  for select using (auth.uid() in (requester_id, addressee_id));
drop policy if exists "friendship - insert own" on public.friendships;
create policy "friendship - insert own" on public.friendships
  for insert with check (auth.uid() = requester_id);
drop policy if exists "friendship - update addressee" on public.friendships;
create policy "friendship - update addressee" on public.friendships
  for update using (auth.uid() = addressee_id);
drop policy if exists "friendship - delete own" on public.friendships;
create policy "friendship - delete own" on public.friendships
  for delete using (auth.uid() in (requester_id, addressee_id));

drop policy if exists "friends read logs" on public.logs;
create policy "friends read logs" on public.logs
  for select using (
    exists (select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester_id = auth.uid() and f.addressee_id = logs.user_id)
          or (f.addressee_id = auth.uid() and f.requester_id = logs.user_id))));

drop policy if exists "friends read sleep" on public.sleep_entries;
create policy "friends read sleep" on public.sleep_entries
  for select using (
    exists (select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester_id = auth.uid() and f.addressee_id = sleep_entries.user_id)
          or (f.addressee_id = auth.uid() and f.requester_id = sleep_entries.user_id))));

create or replace function public.send_friend_request(p_email text)
returns table (friend_id uuid, email text, username text, status text)
language plpgsql security definer set search_path = public, auth
as $$
declare v_uid uuid; v_existing text;
begin
  select u.id into v_uid from auth.users u where lower(u.email) = lower(trim(p_email));
  if v_uid is null then raise exception 'No BrightMind account found for that email'; end if;
  if v_uid = auth.uid() then raise exception 'You cannot add yourself as a friend'; end if;
  select f.status into v_existing from public.friendships f
    where (f.requester_id = auth.uid() and f.addressee_id = v_uid)
       or (f.requester_id = v_uid and f.addressee_id = auth.uid()) limit 1;
  if v_existing = 'accepted' then raise exception 'You are already friends';
  elsif exists (select 1 from public.friendships f
                where f.requester_id = v_uid and f.addressee_id = auth.uid() and f.status = 'pending') then
    update public.friendships set status = 'accepted', responded_at = now()
      where requester_id = v_uid and addressee_id = auth.uid();
  elsif v_existing = 'pending' then raise exception 'Friend request already sent';
  else
    insert into public.friendships (requester_id, addressee_id, status) values (auth.uid(), v_uid, 'pending');
  end if;
  return query select u.id, u.email::text, (u.raw_user_meta_data->>'username'),
    (select f.status from public.friendships f
       where (f.requester_id = auth.uid() and f.addressee_id = v_uid)
          or (f.requester_id = v_uid and f.addressee_id = auth.uid()) limit 1)
    from auth.users u where u.id = v_uid;
end; $$;

create or replace function public.respond_friend_request(p_requester uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public, auth
as $$
begin
  if p_accept then
    update public.friendships set status = 'accepted', responded_at = now()
      where requester_id = p_requester and addressee_id = auth.uid() and status = 'pending';
  else
    delete from public.friendships
      where requester_id = p_requester and addressee_id = auth.uid() and status = 'pending';
  end if;
end; $$;

create or replace function public.remove_friend(p_friend uuid)
returns void language plpgsql security definer set search_path = public, auth
as $$
begin
  delete from public.friendships
    where (requester_id = auth.uid() and addressee_id = p_friend)
       or (requester_id = p_friend and addressee_id = auth.uid());
end; $$;

create or replace function public.get_my_friends()
returns table (friend_id uuid, email text, username text, streak_count int, last_log_date date)
language sql security definer set search_path = public, auth
as $$
  select u.id, u.email::text, (u.raw_user_meta_data->>'username'), p.streak_count, p.last_log_date
  from public.friendships f
  join auth.users u on u.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  left join public.profiles p on p.id = u.id
  where f.status = 'accepted' and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  order by lower(coalesce(u.raw_user_meta_data->>'username', u.email));
$$;

create or replace function public.get_friend_requests()
returns table (other_id uuid, email text, username text, direction text, requested_at timestamptz)
language sql security definer set search_path = public, auth
as $$
  select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end,
         u.email::text, (u.raw_user_meta_data->>'username'),
         case when f.requester_id = auth.uid() then 'outgoing' else 'incoming' end, f.created_at
  from public.friendships f
  join auth.users u on u.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where f.status = 'pending' and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  order by f.created_at desc;
$$;

grant execute on function public.send_friend_request(text)             to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.remove_friend(uuid)                   to authenticated;
grant execute on function public.get_my_friends()                      to authenticated;
grant execute on function public.get_friend_requests()                 to authenticated;
```

Until this is applied, the Friends tab loads but adding a friend fails with a
missing-function error and the friend/request lists stay empty.

---

## 2026-07 — Adult roles & relationship lookups

Covers: the parent "can't add a child" fix, and showing each party who they're
linked to (player → coach/parent, coach → player's parent, parent → child's coach).

Run this whole block once:

```sql
-- 1) Let parents (not just coaches) add athletes
create or replace function public.add_player_by_email(p_email text)
returns table (player_id uuid, email text, username text)
language plpgsql security definer set search_path = public, auth
as $$
declare v_uid uuid;
begin
  if coalesce((select role from public.profiles where id = auth.uid()), '') not in ('coach','parent') then
    raise exception 'Only coaches or parents can add athletes';
  end if;
  select u.id into v_uid from auth.users u where lower(u.email) = lower(trim(p_email));
  if v_uid is null then raise exception 'No BrightMind account found for that email'; end if;
  if v_uid = auth.uid() then raise exception 'You cannot add yourself as a player'; end if;
  insert into public.coach_players (coach_id, player_id) values (auth.uid(), v_uid) on conflict do nothing;
  return query select u.id, u.email::text, (u.raw_user_meta_data->>'username')
    from auth.users u where u.id = v_uid;
end;
$$;

-- 2) Player sees their linked coaches & parents
create or replace function public.get_my_adults()
returns table (adult_id uuid, name text, role text)
language sql security definer set search_path = public, auth
as $$
  select u.id, coalesce(u.raw_user_meta_data->>'username', u.email), pr.role
  from public.coach_players cp
  join public.profiles pr on pr.id = cp.coach_id
  join auth.users u       on u.id = cp.coach_id
  where cp.player_id = auth.uid() and pr.role in ('coach','parent')
  order by pr.role, lower(coalesce(u.raw_user_meta_data->>'username', u.email));
$$;

-- 3) Coach sees each player's parent / parent sees each child's coach
create or replace function public.get_roster_counterparts(p_role text)
returns table (player_id uuid, adult_id uuid, adult_name text)
language sql security definer set search_path = public, auth
as $$
  select other.player_id, u.id, coalesce(u.raw_user_meta_data->>'username', u.email)
  from public.coach_players mine
  join public.coach_players other
       on other.player_id = mine.player_id and other.coach_id <> mine.coach_id
  join public.profiles pr on pr.id = other.coach_id and pr.role = p_role
  join auth.users u       on u.id = other.coach_id
  where mine.coach_id = auth.uid()
  order by other.player_id, lower(coalesce(u.raw_user_meta_data->>'username', u.email));
$$;

grant execute on function public.add_player_by_email(text) to authenticated;
grant execute on function public.get_my_adults() to authenticated;
grant execute on function public.get_roster_counterparts(text) to authenticated;
```

Until this is applied, the UI degrades gracefully: parents get an "only coaches"
error when adding a child, and coach/parent names show as **N/A**.

---

## 2026-07 — Match panel slimmed to level / score / performance

Covers: the match section of the daily log now captures only **opponent level**
(a rating, e.g. `5.01`), **final score** (best-of-five games, e.g. `3-1`, `0-3`),
and **self-rated performance** (unchanged 1–10 slider). Two new columns back the
first two fields. The old `match_type` / `tournament_name` / `placement` /
`emotional_state` / `reflection` columns are intentionally left in place so
existing match-day rows still read back — nothing is dropped.

Run this once:

```sql
alter table public.logs add column if not exists opponent_level numeric(4,2);
alter table public.logs add column if not exists final_score    text;
```

Until this is applied, saving a match-day log fails with a missing-column error
from Supabase.

---

## 2026-07 — Sleep as a once-a-day entry

Covers: moving sleep duration & quality off every `logs` row into their own
`sleep_entries` table, captured once per calendar day from the Home dashboard.
No backfill — existing sleep stays on old `logs` rows and still renders.

Run this whole block once:

```sql
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

drop policy if exists "coach reads player sleep" on public.sleep_entries;
create policy "coach reads player sleep" on public.sleep_entries
  for select using (
    exists (
      select 1 from public.coach_players cp
      where cp.coach_id = auth.uid() and cp.player_id = sleep_entries.user_id
    )
  );
```

Until this is applied, the dashboard sleep card can't save (Supabase returns a
missing-relation error) and sleep-based charts show only legacy per-log values.
The old `logs.sleep_hours` / `logs.sleep_quality` columns are intentionally left
in place — nothing needs to be dropped.
