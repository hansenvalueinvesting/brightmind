# Database migrations

`schema.sql` is the source of truth for the database, but editing it does **not**
change the live Supabase database — Postgres functions/tables must be applied
manually in the Supabase SQL Editor (Dashboard → SQL Editor → New query → Run).

This file tracks changes that still need to be (or have been) applied to the live
database, so the code and the database don't silently drift apart.

Everything below is safe to re-run (`create or replace` / `grant`).

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
