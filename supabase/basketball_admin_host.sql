-- App owner (admin) can open, host and manage any Basketball match; normal users only their own.
create or replace function public.bb__is_host(o uuid) returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (auth.uid() = o or coalesce((select is_admin from profiles where id = auth.uid()), false))
$$;
revoke all on function public.bb__is_host(uuid) from public, anon;
grant execute on function public.bb__is_host(uuid) to authenticated;

do $$ declare f record; d text; n int := 0; begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname like 'bb%' and p.proname <> 'bb__is_host' loop
    d := pg_get_functiondef(f.oid);
    if position('auth.uid() <> m.owner' in d) > 0 or position('auth.uid() = m.owner' in d) > 0 then
      d := replace(d, 'auth.uid() is null or auth.uid() <> m.owner', 'not public.bb__is_host(m.owner)');
      d := replace(d, 'auth.uid() is not null and auth.uid() = m.owner', 'public.bb__is_host(m.owner)');
      execute d; n := n + 1;
    end if;
  end loop;
  raise notice 'patched % functions', n;
end $$;

drop policy if exists bb_matches_own on public.bb_matches;
create policy bb_matches_own on public.bb_matches for select to authenticated using (public.bb__is_host(owner));
drop policy if exists bb_players_own on public.bb_players;
create policy bb_players_own on public.bb_players for select to authenticated using (exists (select 1 from public.bb_matches m where m.id = match_id and public.bb__is_host(m.owner)));
drop policy if exists bb_events_own on public.bb_events;
create policy bb_events_own on public.bb_events for select to authenticated using (exists (select 1 from public.bb_matches m where m.id = match_id and public.bb__is_host(m.owner)));
drop policy if exists bb_devices_own on public.bb_devices;
create policy bb_devices_own on public.bb_devices for select to authenticated using (exists (select 1 from public.bb_matches m where m.id = match_id and public.bb__is_host(m.owner)));
drop policy if exists bb_audit_own on public.bb_audit;
create policy bb_audit_own on public.bb_audit for select to authenticated using (exists (select 1 from public.bb_matches m where m.id = match_id and public.bb__is_host(m.owner)));
