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
