create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  username text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.user_games (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  subtitle text,
  pgn text not null,
  updated_at_ms bigint not null,
  game_date text,
  result text not null,
  termination text,
  move_count integer not null,
  final_fen text not null,
  white_accuracy numeric,
  black_accuracy numeric,
  created_at timestamptz not null default now()
);

create index if not exists user_games_user_id_idx on public.user_games(user_id);
create index if not exists user_games_user_date_idx on public.user_games(user_id, game_date desc, updated_at_ms desc);

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, created_at, updated_at)
  values (new.id, new.email, now(), now())
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists create_profile_after_auth_user_insert on auth.users;
create trigger create_profile_after_auth_user_insert
after insert on auth.users
for each row execute function public.create_profile_for_auth_user();

revoke execute on function public.create_profile_for_auth_user() from public, anon, authenticated;

insert into public.profiles (id, email, created_at, updated_at)
select id, email, created_at, now()
from auth.users
on conflict (id) do update
  set email = excluded.email,
      updated_at = now();

alter table public.profiles enable row level security;
alter table public.user_games enable row level security;

grant select, insert, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.user_games to authenticated;

drop policy if exists "Profiles are readable by owner" on public.profiles;
create policy "Profiles are readable by owner"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

drop policy if exists "Profiles are writable by owner" on public.profiles;
create policy "Profiles are writable by owner"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists "Profiles are updatable by owner" on public.profiles;
create policy "Profiles are updatable by owner"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "Games are readable by owner" on public.user_games;
create policy "Games are readable by owner"
on public.user_games
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Games are writable by owner" on public.user_games;
create policy "Games are writable by owner"
on public.user_games
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Games are updatable by owner" on public.user_games;
create policy "Games are updatable by owner"
on public.user_games
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Games are deletable by owner" on public.user_games;
create policy "Games are deletable by owner"
on public.user_games
for delete
to authenticated
using (auth.uid() = user_id);
