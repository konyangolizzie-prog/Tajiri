-- Tajiri POS · Supabase schema
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query),
-- then enable Email provider in Authentication → Providers.

-- Staff account profiles. One row per Supabase auth user; id matches auth.uid().
create table if not exists public.users (
    id uuid primary key references auth.users (id) on delete cascade,
    key text unique,
    name text not null,
    username text unique,
    email text not null unique,
    phone text default '',
    role text not null check (role in ('admin', 'cashier')),
    created_at timestamptz not null default now()
);

-- Bootstrap / system state. The 'bootstrap' row holds admin setup status:
--   { adminUid: uuid, adminCount: int, createdAt: timestamptz }
create table if not exists public.system (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;

alter table public.system enable row level security;

-- Users: anyone signed in may read the staff roster (admins manage it).
create policy "users read while signed in" on public.users for
select to authenticated using (true);

create policy "users update own profile" on public.users for
update to authenticated using (auth.uid () = id)
with
    check (auth.uid () = id);

create policy "users insert own profile" on public.users for
insert
    to authenticated
with
    check (auth.uid () = id);

-- Bootstrap row: readable by everyone so the sign-up page can check whether
-- first-admin setup is still open; writable only through the RPC below.
create policy "bootstrap readable by anyone" on public.system for
select using (true);

create policy "bootstrap written via rpc only" on public.system for all to authenticated using (false)
with
    check (false);

-- Atomic first-admin bootstrap claim. Returns the current count so the caller
-- can detect a completed setup.
create or replace function public.claim_admin_bootstrap(p_admin_uid uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
begin
  select coalesce((value ->> 'adminCount')::int, 0)
    into current_count
    from public.system
   where key = 'bootstrap';

  if current_count is null then
    insert into public.system (key, value)
    values ('bootstrap', jsonb_build_object(
      'adminUid', p_admin_uid,
      'adminCount', 1,
      'createdAt', now()
    ))
    on conflict (key) do nothing;
    return 1;
  end if;

  if current_count >= 3 then
    raise exception 'The store already has the maximum of 3 administrators.';
  end if;

  update public.system
     set value = jsonb_set(value, '{adminCount}', to_jsonb(current_count + 1)) ||
                 jsonb_build_object('lastAdminUid', p_admin_uid),
         updated_at = now()
   where key = 'bootstrap';

  return current_count + 1;
end;
$$;

-- Optional helper used by the shim's user.delete() cleanup path.
create or replace function public.delete_own_auth_user()
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;