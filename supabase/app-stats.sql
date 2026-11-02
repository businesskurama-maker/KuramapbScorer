-- Already applied. Public, aggregate-only stats for the lobby (no personal data).
create or replace function public.app_stats()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('players', (select count(*) from public.profiles), 'active_passes', (select count(*) from public.profiles where pass_until > now()));
$$;
revoke all on function public.app_stats() from public;
grant execute on function public.app_stats() to anon, authenticated;
