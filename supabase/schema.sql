-- Kurama Pickleball Scorer — accounts & day-pass credits
-- Run once in Supabase (SQL editor, or applied as a migration).
-- Model: users sign in with Google on the phone remote. 1 credit = a 24-hour pass.
-- Credits are added manually by an admin.

-- ---------- Tables ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text unique,
  full_name   text,
  avatar_url  text,
  credits     integer not null default 0 check (credits >= 0),
  pass_until  timestamptz,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  delta       integer not null,
  reason      text not null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on public.credit_ledger(user_id, created_at desc);

-- Emails that become admins automatically when they first sign in.
create table if not exists public.admin_emails (email text primary key);
insert into public.admin_emails(email) values ('chiomegadeveloper@gmail.com') on conflict do nothing;

-- ---------- New user → profile ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url, is_admin)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url',
    exists (select 1 from public.admin_emails a where a.email = lower(new.email))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Back-fill profiles for users who signed up before this ran
insert into public.profiles (id, email, full_name, avatar_url, is_admin)
select u.id, lower(u.email),
       coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
       u.raw_user_meta_data->>'avatar_url',
       exists (select 1 from public.admin_emails a where a.email = lower(u.email))
from auth.users u
on conflict (id) do nothing;

-- ---------- Helpers ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- ---------- Row level security ----------
alter table public.profiles      enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.admin_emails  enable row level security;

drop policy if exists "own profile or admin" on public.profiles;
create policy "own profile or admin" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists "own ledger or admin" on public.credit_ledger;
create policy "own ledger or admin" on public.credit_ledger
  for select using (user_id = auth.uid() or public.is_admin());
-- No insert/update/delete policies: all changes go through the functions below.

-- ---------- User: start (or resume) a 24-hour pass ----------
create or replace function public.start_day_pass()
returns timestamptz language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN'; end if;
  select * into p from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'NO_PROFILE'; end if;
  if p.pass_until is not null and p.pass_until > now() then
    return p.pass_until;                    -- already active: no charge
  end if;
  if p.credits < 1 then raise exception 'NO_CREDITS'; end if;
  update public.profiles
     set credits = credits - 1, pass_until = now() + interval '24 hours'
   where id = p.id
   returning pass_until into p.pass_until;
  insert into public.credit_ledger(user_id, delta, reason, created_by)
  values (p.id, -1, '24-hour pass', p.id);
  return p.pass_until;
end $$;

-- ---------- Admin: add (or remove) credits by email ----------
create or replace function public.admin_add_credits(target_email text, amount integer, note text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare uid uuid; newbal integer;
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  if amount = 0 then raise exception 'ZERO_AMOUNT'; end if;
  select id into uid from public.profiles where email = lower(trim(target_email));
  if uid is null then raise exception 'USER_NOT_FOUND'; end if;
  update public.profiles set credits = greatest(credits + amount, 0)
   where id = uid returning credits into newbal;
  insert into public.credit_ledger(user_id, delta, reason, created_by)
  values (uid, amount, coalesce(nullif(trim(note), ''), case when amount > 0 then 'Top-up' else 'Adjustment' end), auth.uid());
  return newbal;
end $$;

revoke all on function public.start_day_pass() from public, anon;
revoke all on function public.admin_add_credits(text, integer, text) from public, anon;
grant execute on function public.start_day_pass() to authenticated;
grant execute on function public.admin_add_credits(text, integer, text) to authenticated;

-- Hardening (applied as migration "lock_down_is_admin")
create index if not exists credit_ledger_created_by_idx on public.credit_ledger(created_by);
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
