-- Donation alerts for the owner: web push + live updates
create extension if not exists pg_net with schema extensions;

alter table public.purchases add column if not exists notified_at timestamptz;

create table if not exists public.push_subscriptions (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "admins see own subscriptions" on public.push_subscriptions;
create policy "admins see own subscriptions" on public.push_subscriptions
  for select using (user_id = auth.uid() and public.is_admin());

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;
create or replace function public.delete_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end $$;
revoke all on function public.save_push_subscription(text, text, text) from public, anon;
revoke all on function public.delete_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;

-- Push signing keys (private key never leaves the database / server function)
create table if not exists public.push_config (
  id int primary key default 1 check (id = 1),
  vapid_public text not null,
  vapid_private text not null,
  vapid_subject text not null
);
alter table public.push_config enable row level security;   -- no policies: only the service role can read it
revoke all on public.push_config from anon, authenticated;
insert into public.push_config(id, vapid_public, vapid_private, vapid_subject)
values (1, 'BHQkHCcSS667tABSCh1u_o5fewgqo-roVy7JyHEFIqPhNSGqBZlOqEIFlOeMsVKa1bMrChzMk_EBvbgezYmMHoo', '<VAPID_PRIVATE_KEY — already stored in the database; never commit it>', 'mailto:dinkykongsupport@gmail.com')
on conflict (id) do nothing;

-- Call the alert function whenever a player submits a donation reference
create or replace function public.notify_new_donation()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url := 'https://wwyebsroqypdkeqtiylv.supabase.co/functions/v1/donation-alert',
    body := jsonb_build_object('id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return new;
exception when others then
  return new;   -- never block a donation because of an alert problem
end $$;
drop trigger if exists on_new_donation on public.purchases;
create trigger on_new_donation after insert on public.purchases
  for each row when (new.status = 'pending') execute function public.notify_new_donation();

-- Live updates on the owner page
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'purchases') then
    alter publication supabase_realtime add table public.purchases;
  end if;
end $$;
