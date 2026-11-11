-- =====================================================================================================
-- DinkyKong · Basketball LIVE OBS — SEASONS
-- A season groups matches. Teams + players are registered once per season (max 15 players per team);
-- a season match copies the two rosters (linked by season_player_id) so finished games never change,
-- and season totals / awards are built from every match in the season.
-- Media (season logo WebM + poster, team logos, player photos) lives in the public bucket 'bb-media'
-- under <owner uid>/s/<season id>/… — the owner's browser uploads and removes it.
-- =====================================================================================================

create table if not exists public.bb_seasons (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 60),
  logo text,          -- poster / static logo (WebP URL)
  logo_anim text,     -- animated logo (WebM URL)
  status text not null default 'active' check (status in ('active', 'ended')),
  awards jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists bb_seasons_owner on public.bb_seasons(owner, created_at desc);

create table if not exists public.bb_season_teams (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.bb_seasons(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 15),
  short text not null default '',
  color text not null default '#00e5ff',
  logo text,
  created_at timestamptz not null default now()
);
create index if not exists bb_season_teams_season on public.bb_season_teams(season_id, created_at);

create table if not exists public.bb_season_players (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.bb_seasons(id) on delete cascade,
  team_id uuid not null references public.bb_season_teams(id) on delete cascade,
  number text not null check (number ~ '^[0-9]{1,2}$'),
  first_name text not null default '',
  last_name text not null default '',
  position text not null default '',
  photo text,
  created_at timestamptz not null default now(),
  unique (team_id, number)
);
create index if not exists bb_season_players_team on public.bb_season_players(team_id);
create index if not exists bb_season_players_season on public.bb_season_players(season_id);

alter table public.bb_matches add column if not exists season_id uuid references public.bb_seasons(id) on delete cascade;
create index if not exists bb_matches_season on public.bb_matches(season_id);
alter table public.bb_players add column if not exists season_player_id uuid references public.bb_season_players(id) on delete set null;
create index if not exists bb_players_sp on public.bb_players(season_player_id);

alter table public.bb_seasons enable row level security;
alter table public.bb_season_teams enable row level security;
alter table public.bb_season_players enable row level security;
drop policy if exists bb_seasons_own on public.bb_seasons;
create policy bb_seasons_own on public.bb_seasons for select to authenticated using (public.bb__is_host(owner));
drop policy if exists bb_season_teams_own on public.bb_season_teams;
create policy bb_season_teams_own on public.bb_season_teams for select to authenticated using (exists (select 1 from public.bb_seasons s where s.id = season_id and public.bb__is_host(s.owner)));
drop policy if exists bb_season_players_own on public.bb_season_players;
create policy bb_season_players_own on public.bb_season_players for select to authenticated using (exists (select 1 from public.bb_seasons s where s.id = season_id and public.bb__is_host(s.owner)));
revoke insert, update, delete on public.bb_seasons, public.bb_season_teams, public.bb_season_players from anon, authenticated;
revoke select on public.bb_seasons, public.bb_season_teams, public.bb_season_players from anon;

-- ------------------------------------------------------------------ media bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bb-media', 'bb-media', true, 2097152, array['image/webp', 'image/png', 'image/jpeg', 'video/webm'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg', 'video/webm'];
drop policy if exists bb_media_ins on storage.objects;
create policy bb_media_ins on storage.objects for insert to authenticated with check (bucket_id = 'bb-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists bb_media_upd on storage.objects;
create policy bb_media_upd on storage.objects for update to authenticated using (bucket_id = 'bb-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists bb_media_del on storage.objects;
create policy bb_media_del on storage.objects for delete to authenticated using (bucket_id = 'bb-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists bb_media_sel on storage.objects;
create policy bb_media_sel on storage.objects for select to authenticated using (bucket_id = 'bb-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ------------------------------------------------------------------ helpers
-- only https URLs from our own storage (or nothing) are accepted as media
create or replace function public.bb__media(u text) returns text language sql immutable set search_path = public as $$
  select case when u ~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/bb-media/[A-Za-z0-9/_.-]+$' then left(u, 400) else null end
$$;

create or replace function public.bb__season(p_id uuid, p_write boolean default true) returns public.bb_seasons language plpgsql stable security definer set search_path = public as $$
declare s bb_seasons;
begin
  select * into s from bb_seasons where id = p_id;
  if s.id is null then raise exception 'NO_SEASON'; end if;
  if not bb__is_host(s.owner) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_write and s.status = 'ended' then raise exception 'SEASON_ENDED'; end if;
  return s;
end $$;

-- team JSON keeps the season team id ('sid') so standings can follow a team across matches
create or replace function public.bb__team_ok(t jsonb) returns jsonb language plpgsql immutable set search_path = public as $$
begin
  if t is null or coalesce(btrim(t ->> 'name'), '') = '' then raise exception 'TEAM_NAME_REQUIRED'; end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'name', left(btrim(t ->> 'name'), 40),
    'short', upper(left(btrim(coalesce(nullif(t ->> 'short', ''), left(t ->> 'name', 3))), 5)),
    'color', lower(coalesce(nullif(t ->> 'color', ''), '#00e5ff')),
    'logo', nullif(left(coalesce(t ->> 'logo', ''), 400000), ''),
    'sid', case when coalesce(t ->> 'sid', '') ~ '^[0-9a-f-]{36}$' then t ->> 'sid' end));
end $$;

-- ------------------------------------------------------------------ season CRUD
-- p: { id?, title?, logo?, logo_anim?, status? ('active'|'ended'), awards? }
create or replace function public.bb_season_save(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); s bb_seasons; aw jsonb;
begin
  if uid is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  if coalesce(p ->> 'id', '') = '' then
    if not public.bb_pass_ok(uid) then raise exception 'LIVE_PASS_REQUIRED'; end if;
    if coalesce(btrim(p ->> 'title'), '') = '' then raise exception 'SEASON_TITLE_REQUIRED'; end if;
    insert into bb_seasons (owner, title, logo, logo_anim) values (uid, left(btrim(p ->> 'title'), 60), bb__media(p ->> 'logo'), bb__media(p ->> 'logo_anim')) returning * into s;
  else
    s := bb__season((p ->> 'id')::uuid, false);
    -- an ended season is read-only except reopening it (and its awards)
    if s.status = 'ended' and (p ? 'title' or p ? 'logo' or p ? 'logo_anim') and coalesce(p ->> 'status', '') <> 'active' then raise exception 'SEASON_ENDED'; end if;
    if p ? 'awards' then
      select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('title', left(btrim(a ->> 'title'), 40), 'player', case when coalesce(a ->> 'player', '') ~ '^[0-9a-f-]{36}$' then a ->> 'player' end,
          'team', case when coalesce(a ->> 'team', '') ~ '^[0-9a-f-]{36}$' then a ->> 'team' end, 'note', nullif(left(coalesce(a ->> 'note', ''), 80), '')))), '[]'::jsonb)
        into aw from (select a from jsonb_array_elements(p -> 'awards') a where coalesce(btrim(a ->> 'title'), '') <> '' limit 30) q;
    end if;
    update bb_seasons set
      title = case when p ? 'title' and coalesce(btrim(p ->> 'title'), '') <> '' then left(btrim(p ->> 'title'), 60) else title end,
      logo = case when p ? 'logo' then bb__media(p ->> 'logo') else logo end,
      logo_anim = case when p ? 'logo_anim' then bb__media(p ->> 'logo_anim') else logo_anim end,
      status = case when p ->> 'status' in ('active', 'ended') then p ->> 'status' else status end,
      ended_at = case when p ->> 'status' = 'ended' then coalesce(ended_at, now()) when p ->> 'status' = 'active' then null else ended_at end,
      awards = coalesce(aw, awards)
    where id = s.id returning * into s;
    -- season logo / title shows on OBS: refresh every live screen of this season
    if p ? 'logo' or p ? 'logo_anim' or p ? 'title' then
      perform bb__push(m) from bb_matches m where m.season_id = s.id and m.status <> 'final';
    end if;
  end if;
  return bb_season_get(s.id);
end $$;

-- p: { id?, season_id, name, short, color, logo }
create or replace function public.bb_season_team(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s bb_seasons; tid uuid;
begin
  if coalesce(p ->> 'id', '') = '' then
    s := bb__season((p ->> 'season_id')::uuid);
    if (select count(*) from bb_season_teams where season_id = s.id) >= 64 then raise exception 'TOO_MANY_TEAMS'; end if;
    if coalesce(btrim(p ->> 'name'), '') = '' then raise exception 'TEAM_NAME_REQUIRED'; end if;
    insert into bb_season_teams (season_id, name, short, color, logo)
    values (s.id, left(btrim(p ->> 'name'), 15), upper(left(btrim(coalesce(nullif(p ->> 'short', ''), left(p ->> 'name', 3))), 5)),
      case when coalesce(p ->> 'color', '') ~* '^#[0-9a-f]{6}$' then lower(p ->> 'color') else '#00e5ff' end, bb__media(p ->> 'logo'))
    returning id into tid;
  else
    select t.season_id into tid from bb_season_teams t where t.id = (p ->> 'id')::uuid;
    if tid is null then raise exception 'NO_TEAM'; end if;
    s := bb__season(tid); tid := (p ->> 'id')::uuid;
    update bb_season_teams set
      name = case when coalesce(btrim(p ->> 'name'), '') <> '' then left(btrim(p ->> 'name'), 15) else name end,
      short = case when p ? 'short' then upper(left(btrim(coalesce(nullif(p ->> 'short', ''), left(name, 3))), 5)) else short end,
      color = case when coalesce(p ->> 'color', '') ~* '^#[0-9a-f]{6}$' then lower(p ->> 'color') else color end,
      logo = case when p ? 'logo' then bb__media(p ->> 'logo') else logo end
    where id = tid;
  end if;
  return bb_season_get(s.id);
end $$;

create or replace function public.bb_season_team_delete(p_id uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare s bb_seasons; sid uuid;
begin
  select season_id into sid from bb_season_teams where id = p_id;
  if sid is null then raise exception 'NO_TEAM'; end if;
  s := bb__season(sid);
  if exists (select 1 from bb_matches m where m.season_id = s.id and (m.home ->> 'sid' = p_id::text or m.away ->> 'sid' = p_id::text)) then raise exception 'TEAM_HAS_MATCHES'; end if;
  delete from bb_season_teams where id = p_id;
  return bb_season_get(s.id);
end $$;

-- p: { id?, team_id, number, first, last, position, photo }
create or replace function public.bb_season_player(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s bb_seasons; t bb_season_teams; pid uuid;
begin
  if coalesce(p ->> 'number', '0') !~ '^[0-9]{1,2}$' then raise exception 'BAD_JERSEY'; end if;
  begin
    if coalesce(p ->> 'id', '') = '' then
      select * into t from bb_season_teams where id = (p ->> 'team_id')::uuid;
      if t.id is null then raise exception 'NO_TEAM'; end if;
      s := bb__season(t.season_id);
      if (select count(*) from bb_season_players where team_id = t.id) >= 15 then raise exception 'ROSTER_FULL'; end if;
      insert into bb_season_players (season_id, team_id, number, first_name, last_name, position, photo)
      values (s.id, t.id, p ->> 'number', left(btrim(coalesce(p ->> 'first', '')), 40), left(btrim(coalesce(p ->> 'last', '')), 40),
        upper(left(btrim(coalesce(p ->> 'position', '')), 4)), bb__media(p ->> 'photo')) returning id into pid;
    else
      select sp.season_id into pid from bb_season_players sp where sp.id = (p ->> 'id')::uuid;
      if pid is null then raise exception 'NO_PLAYER'; end if;
      s := bb__season(pid);
      update bb_season_players set
        number = coalesce(p ->> 'number', number),
        first_name = case when p ? 'first' then left(btrim(p ->> 'first'), 40) else first_name end,
        last_name = case when p ? 'last' then left(btrim(p ->> 'last'), 40) else last_name end,
        position = case when p ? 'position' then upper(left(btrim(p ->> 'position'), 4)) else position end,
        photo = case when p ? 'photo' then bb__media(p ->> 'photo') else photo end
      where id = (p ->> 'id')::uuid;
      -- a new photo also shows in this season's matches that have not started yet
      if p ? 'photo' then
        update bb_players bp set photo = bb__media(p ->> 'photo') from bb_matches m
        where bp.season_player_id = (p ->> 'id')::uuid and m.id = bp.match_id and m.status = 'setup';
      end if;
    end if;
  exception when unique_violation then raise exception 'DUPLICATE_JERSEY';
  end;
  return bb_season_get(s.id);
end $$;

create or replace function public.bb_season_player_delete(p_id uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare s bb_seasons; sid uuid;
begin
  select season_id into sid from bb_season_players where id = p_id;
  if sid is null then raise exception 'NO_PLAYER'; end if;
  s := bb__season(sid);
  delete from bb_season_players where id = p_id;   -- match rosters keep their copy (season_player_id → null)
  return bb_season_get(s.id);
end $$;

-- STRICT delete: the caller must type the season title. Removes the season, its teams, players, matches and stats.
create or replace function public.bb_season_delete(p_id uuid, p_title text) returns jsonb language plpgsql security definer set search_path = public as $$
declare s bb_seasons; n int;
begin
  s := bb__season(p_id, false);
  if auth.uid() <> s.owner then raise exception 'OWNER_ONLY'; end if;
  if upper(regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g')) <> upper(regexp_replace(btrim(s.title), '\s+', ' ', 'g')) then raise exception 'TITLE_MISMATCH'; end if;
  select count(*) into n from bb_matches where season_id = s.id;
  delete from bb_seasons where id = s.id;
  return jsonb_build_object('ok', true, 'matches', n);
end $$;

-- ------------------------------------------------------------------ read: one season with teams, players, matches, stats
create or replace function public.bb_season_get(p_id uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s bb_seasons;
begin
  s := bb__season(p_id, false);
  return jsonb_build_object('id', s.id, 'owner', s.owner, 'title', s.title, 'logo', s.logo, 'logo_anim', s.logo_anim, 'status', s.status, 'awards', s.awards,
    'created_at', s.created_at, 'ended_at', s.ended_at,
    'teams', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'short', t.short, 'color', t.color, 'logo', t.logo,
        'players', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'number', p.number, 'first', p.first_name, 'last', p.last_name, 'position', p.position, 'photo', p.photo)
            order by p.number::int), '[]'::jsonb) from bb_season_players p where p.team_id = t.id)) order by t.created_at), '[]'::jsonb)
      from bb_season_teams t where t.season_id = s.id),
    'matches', (select coalesce(jsonb_agg(jsonb_build_object('code', m.code, 'title', m.title, 'venue', m.venue, 'status', m.status, 'round', m.broadcast ->> 'round',
        'home', m.home - 'logo', 'away', m.away - 'logo', 'score', m.derived -> 'score', 'starts_at', m.starts_at, 'created_at', m.created_at) order by coalesce(m.starts_at, m.created_at) desc), '[]'::jsonb)
      from bb_matches m where m.season_id = s.id),
    'stats', bb__season_stats(s.id));
end $$;

-- season totals: players (from every started match of the season) and team standings (final matches)
create or replace function public.bb__season_stats(p_season uuid) returns jsonb language sql stable security definer set search_path = public as $$
  with mp as (
    select bp.season_player_id spid, m.id mid, m.derived -> 'players' -> (bp.id::text) st,
      exists (select 1 from bb_events e where e.match_id = m.id and not e.undone and (e.player_id = bp.id
        or (e.type = 'lineup' and e.data -> 'ids' ? bp.id::text) or (e.type = 'sub' and e.data -> 'in' ? bp.id::text))) played
    from bb_matches m join bb_players bp on bp.match_id = m.id
    where m.season_id = p_season and m.status <> 'setup' and bp.season_player_id is not null),
  pl as (
    select spid, count(*) filter (where played) gp,
      sum(coalesce((st ->> 'pts')::int, 0)) pts, sum(coalesce((st ->> 'm1')::int, 0)) m1, sum(coalesce((st ->> 'm2')::int, 0)) m2,
      sum(coalesce((st ->> 'm3')::int, 0)) m3, sum(coalesce((st ->> 'fouls')::int, 0)) f, sum(coalesce((st ->> 'reb')::int, 0)) reb,
      sum(coalesce((st ->> 'ast')::int, 0)) ast, sum(coalesce((st ->> 'stl')::int, 0)) stl, sum(coalesce((st ->> 'blk')::int, 0)) blk
    from mp group by spid),
  tm as (
    select x.sid, count(*) gp, count(*) filter (where x.pf > x.pa) w, count(*) filter (where x.pf < x.pa) l, sum(x.pf) pf, sum(x.pa) pa
    from (select m.home ->> 'sid' sid, (m.derived -> 'score' ->> 'home')::int pf, (m.derived -> 'score' ->> 'away')::int pa from bb_matches m where m.season_id = p_season and m.status = 'final'
          union all
          select m.away ->> 'sid', (m.derived -> 'score' ->> 'away')::int, (m.derived -> 'score' ->> 'home')::int from bb_matches m where m.season_id = p_season and m.status = 'final') x
    where x.sid is not null group by x.sid)
  select jsonb_build_object(
    'players', (select coalesce(jsonb_object_agg(spid::text, jsonb_build_object('gp', gp, 'pts', pts, 'm1', m1, 'm2', m2, 'm3', m3, 'f', f, 'reb', reb, 'ast', ast, 'stl', stl, 'blk', blk)), '{}'::jsonb) from pl),
    'teams', (select coalesce(jsonb_object_agg(sid, jsonb_build_object('gp', gp, 'w', w, 'l', l, 'pf', pf, 'pa', pa)), '{}'::jsonb) from tm))
$$;

-- list for the Seasons tab and the Match-setup picker
create or replace function public.bb_seasons_list() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'logo', s.logo, 'logo_anim', s.logo_anim, 'status', s.status, 'owner', s.owner, 'created_at', s.created_at,
      'teams', (select count(*) from bb_season_teams t where t.season_id = s.id),
      'players', (select count(*) from bb_season_players p where p.season_id = s.id),
      'matches', (select count(*) from bb_matches m where m.season_id = s.id),
      'final', (select count(*) from bb_matches m where m.season_id = s.id and m.status = 'final')) order by s.status, s.created_at desc), '[]'::jsonb)
  from bb_seasons s where bb__is_host(s.owner)
$$;

-- ------------------------------------------------------------------ matches inside a season
create or replace function public.bb_create(p jsonb) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); m bb_matches; c text; pl jsonb; h jsonb; a jsonb; n int := 0; ssn uuid; sp uuid;
begin
  if uid is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  if not public.bb_pass_ok(uid) then raise exception 'LIVE_PASS_REQUIRED'; end if;
  if coalesce(p ->> 'season_id', '') <> '' then ssn := (bb__season((p ->> 'season_id')::uuid)).id; end if;
  h := bb__team_ok(p -> 'home'); a := bb__team_ok(p -> 'away');
  if ssn is null then h := h - 'sid'; a := a - 'sid';
  else
    if h ? 'sid' and not exists (select 1 from bb_season_teams where id = (h ->> 'sid')::uuid and season_id = ssn) then h := h - 'sid'; end if;
    if a ? 'sid' and not exists (select 1 from bb_season_teams where id = (a ->> 'sid')::uuid and season_id = ssn) then a := a - 'sid'; end if;
    if h ->> 'sid' = a ->> 'sid' then raise exception 'SAME_TEAM'; end if;
  end if;
  if bb__cdist(h ->> 'color', a ->> 'color') < 110 then raise exception 'COLORS_TOO_CLOSE'; end if;
  loop
    c := ''; for i in 1..6 loop c := c || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1); end loop;
    exit when not exists (select 1 from bb_matches where code = c);
    n := n + 1; if n > 20 then raise exception 'CODE_RETRY'; end if;
  end loop;
  insert into bb_matches (code, owner, view_key, pin, title, venue, starts_at, home, away, config, broadcast, season_id)
  values (c, uid, encode(gen_random_bytes(12), 'hex'), lpad((floor(random() * 1000000))::int::text, 6, '0'),
    left(coalesce(p ->> 'title', ''), 80), left(coalesce(p ->> 'venue', ''), 80), nullif(p ->> 'starts_at', '')::timestamptz,
    h, a, bb__cfg_default() || coalesce(p -> 'config', '{}'::jsonb), bb__bcast_default() || coalesce(p -> 'broadcast', '{}'::jsonb), ssn)
  returning * into m;
  for pl in select * from jsonb_array_elements(coalesce(p -> 'players', '[]'::jsonb)) loop
    sp := null;
    if ssn is not null and coalesce(pl ->> 'spid', '') ~ '^[0-9a-f-]{36}$' then
      select x.id into sp from bb_season_players x where x.id = (pl ->> 'spid')::uuid and x.season_id = ssn
        and x.team_id::text = (case pl ->> 'team' when 'home' then h else a end) ->> 'sid';
    end if;
    insert into bb_players (match_id, team, number, first_name, last_name, display, position, photo, active, starter, season_player_id)
    values (m.id, pl ->> 'team', pl ->> 'number', left(coalesce(pl ->> 'first', ''), 40), left(coalesce(pl ->> 'last', ''), 40),
      left(coalesce(pl ->> 'display', ''), 40), left(coalesce(pl ->> 'position', ''), 12),
      coalesce(bb__media(pl ->> 'photo'), nullif(left(coalesce(pl ->> 'photo', ''), 300000), '')),
      coalesce((pl ->> 'active')::boolean, true), coalesce((pl ->> 'starter')::boolean, false), sp);
  end loop;
  update bb_matches set
    clock = jsonb_build_object('running', false, 'ms', bb__period_ms(config, 1), 'at', bb__now(),
      'shot', jsonb_build_object('running', false, 'ms', coalesce((config ->> 'shot_full')::int, 24) * 1000, 'at', bb__now())),
    overlay = jsonb_build_object('hidden', false, 'banner', null, 'reset', 0)
  where id = m.id returning * into m;
  update bb_matches set derived = bb__derive(m) where id = m.id returning * into m;
  insert into bb_audit (match_id, actor, action, detail) values (m.id, 'Host', 'create', jsonb_build_object('title', m.title, 'season', ssn));
  return jsonb_build_object('code', m.code, 'pin', m.pin, 'view_key', m.view_key);
exception when unique_violation then raise exception 'DUPLICATE_JERSEY';
end $$;

-- snapshot carries the season (title + logos) for the OBS corner logo
create or replace function public.bb__snap(m public.bb_matches) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'code', m.code, 'title', m.title, 'venue', m.venue, 'starts_at', m.starts_at, 'status', m.status,
    'home', m.home, 'away', m.away, 'config', m.config, 'broadcast', m.broadcast, 'clock', m.clock, 'overlay', m.overlay,
    'derived', m.derived, 'version', m.version, 'locked', m.settings_locked, 'allow_multi', m.allow_multi,
    'can_redo', jsonb_array_length(m.redo) > 0, 'now', bb__now(), 'finalized_at', m.finalized_at, 'created_at', m.created_at,
    'season', (select jsonb_build_object('id', s.id, 'title', s.title, 'logo', s.logo, 'logo_anim', s.logo_anim) from bb_seasons s where s.id = m.season_id),
    'players', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'team', p.team, 'number', p.number, 'first', p.first_name,
        'last', p.last_name, 'display', p.display, 'position', p.position, 'photo', p.photo, 'active', p.active, 'starter', p.starter)
        order by p.team, p.number::int), '[]'::jsonb) from bb_players p where p.match_id = m.id),
    'recent', (select coalesce(jsonb_agg(r order by r.seq desc), '[]'::jsonb) from (
        select e.id, e.seq, e.type, e.team, e.player_id, e.value, e.period, e.data, e.actor, e.undone, e.created_at
        from bb_events e where e.match_id = m.id order by e.seq desc limit 15) r),
    'devices', (select count(*) from bb_devices d where d.match_id = m.id and not d.revoked));
end $$;

-- ------------------------------------------------------------------ starting five + substitutions are validated on the server
do $$ declare d text; begin
  d := pg_get_functiondef('public.bb_act(text,text,uuid,text,jsonb)'::regprocedure);
  d := replace(d, $x$  elsif p_type = 'lineup' or p_type = 'sub' then
    if v_team is null then raise exception 'BAD_TEAM'; end if;
    fold := true;$x$, $x$  elsif p_type = 'lineup' or p_type = 'sub' then
    if v_team is null then raise exception 'BAD_TEAM'; end if;
    v_pid := null;
    declare
      cap int := case when m.config ->> 'format' = '3x3' then 3 else 5 end;
      ids jsonb := case when p_type = 'lineup' then coalesce(d -> 'ids', '[]'::jsonb) else coalesce(d -> 'in', '[]'::jsonb) || coalesce(d -> 'out', '[]'::jsonb) end;
      oncrt jsonb := coalesce(m.derived -> 'oncourt' -> v_team, '[]'::jsonb);
      x text;
    begin
      if jsonb_typeof(ids) <> 'array' then raise exception 'BAD_LINEUP'; end if;
      for x in select jsonb_array_elements_text(ids) loop
        if x !~ '^[0-9a-f-]{36}$' or not exists (select 1 from bb_players where id = x::uuid and match_id = m.id and team = v_team) then raise exception 'BAD_PLAYER'; end if;
      end loop;
      if (select count(distinct q.xid) from jsonb_array_elements_text(ids) q(xid)) <> jsonb_array_length(ids) then raise exception 'BAD_LINEUP'; end if;
      if p_type = 'lineup' then
        if jsonb_array_length(ids) < 1 or jsonb_array_length(ids) > cap then raise exception 'LINEUP_SIZE'; end if;
        d := jsonb_build_object('ids', ids);
      else
        if jsonb_array_length(coalesce(d -> 'in', '[]'::jsonb)) <> jsonb_array_length(coalesce(d -> 'out', '[]'::jsonb)) or jsonb_array_length(coalesce(d -> 'in', '[]'::jsonb)) = 0 then raise exception 'SUB_COUNT'; end if;
        for x in select jsonb_array_elements_text(d -> 'out') loop if not oncrt ? x then raise exception 'SUB_NOT_ON_COURT'; end if; end loop;
        for x in select jsonb_array_elements_text(d -> 'in') loop if oncrt ? x then raise exception 'SUB_ALREADY_ON'; end if; end loop;
        d := jsonb_build_object('in', d -> 'in', 'out', d -> 'out');
      end if;
    end;
    fold := true;$x$);
  if position('LINEUP_SIZE' in d) = 0 then raise exception 'bb_act patch failed'; end if;
  execute d;
end $$;

-- ------------------------------------------------------------------ grants
revoke all on function public.bb_season_save(jsonb), public.bb_season_team(jsonb), public.bb_season_team_delete(uuid), public.bb_season_player(jsonb),
  public.bb_season_player_delete(uuid), public.bb_season_delete(uuid, text), public.bb_season_get(uuid), public.bb_seasons_list() from public, anon;
grant execute on function public.bb_season_save(jsonb), public.bb_season_team(jsonb), public.bb_season_team_delete(uuid), public.bb_season_player(jsonb),
  public.bb_season_player_delete(uuid), public.bb_season_delete(uuid, text), public.bb_season_get(uuid), public.bb_seasons_list() to authenticated;
revoke all on function public.bb__season(uuid, boolean), public.bb__season_stats(uuid) from public, anon, authenticated;
revoke all on function public.bb_create(jsonb) from public, anon;
grant execute on function public.bb_create(jsonb) to authenticated;
revoke all on function public.bb__snap(public.bb_matches) from public, anon, authenticated;
