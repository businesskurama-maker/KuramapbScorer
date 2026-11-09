-- =====================================================================================================
-- DinkyKong · Basketball LIVE OBS
-- Server-authoritative basketball scoring. Every change goes through bb_act(): it checks the caller's role,
-- de-duplicates by event id, stores the event, rebuilds the score/stats from the event log, bumps the
-- version and pushes the new snapshot to OBS + remotes over Realtime (topic 'bb:<view_key>').
-- Clients never write tables directly.
-- =====================================================================================================

create table if not exists public.bb_matches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  owner uuid not null references auth.users(id) on delete cascade,
  view_key text not null,
  pin text not null,
  pin_fail int not null default 0,
  pin_fail_at timestamptz,
  title text not null default '',
  venue text not null default '',
  starts_at timestamptz,
  home jsonb not null,
  away jsonb not null,
  config jsonb not null,
  broadcast jsonb not null default '{}'::jsonb,
  clock jsonb not null default '{}'::jsonb,
  overlay jsonb not null default '{}'::jsonb,
  derived jsonb not null default '{}'::jsonb,
  redo jsonb not null default '[]'::jsonb,
  status text not null default 'setup' check (status in ('setup', 'live', 'final')),
  settings_locked boolean not null default false,
  allow_multi boolean not null default true,
  version bigint not null default 1,
  seq bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz
);
create index if not exists bb_matches_owner on public.bb_matches(owner, created_at desc);

create table if not exists public.bb_players (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.bb_matches(id) on delete cascade,
  team text not null check (team in ('home', 'away')),
  number text not null check (number ~ '^[0-9]{1,2}$'),
  first_name text not null default '',
  last_name text not null default '',
  display text not null default '',
  position text not null default '',
  photo text,
  active boolean not null default true,
  starter boolean not null default false,
  created_at timestamptz not null default now(),
  unique (match_id, team, number)
);

create table if not exists public.bb_events (
  id uuid primary key,
  match_id uuid not null references public.bb_matches(id) on delete cascade,
  seq bigint not null,
  type text not null,
  team text check (team in ('home', 'away')),
  player_id uuid references public.bb_players(id) on delete set null,
  value int not null default 0,
  period int not null default 1,
  data jsonb not null default '{}'::jsonb,
  actor text not null default '',
  actor_role text not null default '',
  undone boolean not null default false,
  undone_at timestamptz,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  unique (match_id, seq)
);
create index if not exists bb_events_match on public.bb_events(match_id, seq);
create index if not exists bb_events_player on public.bb_events(player_id);

create table if not exists public.bb_devices (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.bb_matches(id) on delete cascade,
  token_hash text not null unique,
  role text not null check (role in ('scorekeeper', 'clock', 'viewer')),
  name text not null default '',
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists bb_devices_match on public.bb_devices(match_id);

create table if not exists public.bb_audit (
  id bigserial primary key,
  match_id uuid not null references public.bb_matches(id) on delete cascade,
  actor text not null default '',
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists bb_audit_match on public.bb_audit(match_id, at desc);

-- Owners may READ their own data (portal / history). All writes go through the functions below.
alter table public.bb_matches enable row level security;
alter table public.bb_players enable row level security;
alter table public.bb_events enable row level security;
alter table public.bb_devices enable row level security;
alter table public.bb_audit enable row level security;
drop policy if exists bb_matches_own on public.bb_matches;
create policy bb_matches_own on public.bb_matches for select to authenticated using (owner = (select auth.uid()));
drop policy if exists bb_players_own on public.bb_players;
create policy bb_players_own on public.bb_players for select to authenticated using (exists (select 1 from public.bb_matches m where m.id = match_id and m.owner = (select auth.uid())));
drop policy if exists bb_events_own on public.bb_events;
create policy bb_events_own on public.bb_events for select to authenticated using (exists (select 1 from public.bb_matches m where m.id = match_id and m.owner = (select auth.uid())));
drop policy if exists bb_devices_own on public.bb_devices;
create policy bb_devices_own on public.bb_devices for select to authenticated using (exists (select 1 from public.bb_matches m where m.id = match_id and m.owner = (select auth.uid())));
drop policy if exists bb_audit_own on public.bb_audit;
create policy bb_audit_own on public.bb_audit for select to authenticated using (exists (select 1 from public.bb_matches m where m.id = match_id and m.owner = (select auth.uid())));
revoke insert, update, delete on public.bb_matches, public.bb_players, public.bb_events, public.bb_devices, public.bb_audit from anon, authenticated;
revoke select on public.bb_matches, public.bb_players, public.bb_events, public.bb_devices, public.bb_audit from anon;

-- ------------------------------------------------------------------ helpers
create or replace function public.bb__cfg_default() returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'preset', 'fiba', 'format', '5v5', 'periods', 4, 'period_min', 10, 'ot_min', 5,
    'shot_on', true, 'shot_full', 24, 'shot_short', 14,
    'pf_limit', 5, 'fiba_dq', true,
    'tf_limit', 4, 'tf_reset', 'period', 'tf_ot_continues', true, 'tf_kinds', jsonb_build_array('P', 'T', 'U', 'D'),
    'to_mode', 'halves', 'to_h1', 2, 'to_h2', 3, 'to_ot', 1, 'to_game', 5, 'to_period', 1, 'to_secs', 60,
    'timer_mode', 'digital', 'tenths', true, 'buzzer', true, 'sk_clock', true, 'player_scoring', true)
$$;

create or replace function public.bb__bcast_default() returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'theme', 'electric', 'scale', 1, 'pos', 'bottom', 'opacity', 0.94, 'anim_ms', 3000,
    'names', 'short', 'font', 'digital', 'digit_size', 1,
    'show_fouls', true, 'show_tos', true, 'show_poss', true, 'show_player', true,
    'timer_win', 'auto', 'timer_w', 150, 'timer_h', 60, 'reduced_motion', false, 'show_title', false)
$$;

-- current "window" key for team fouls / timeouts
create or replace function public.bb__win(p int, periods int, mode text, ot_cont boolean) returns text language sql immutable set search_path = public as $$
  select case
    when mode = 'game' then 'g'
    when mode = 'halves' or mode = 'half' then
      case when p <= greatest(1, periods / 2) then 'h1' when p <= periods then 'h2'
           when ot_cont then 'h2' else 'ot' || p end
    else case when p > periods and ot_cont then periods::text else p::text end
  end
$$;

-- Euclidean RGB distance between two #rrggbb colours (0..441)
create or replace function public.bb__cdist(a text, b text) returns numeric language plpgsql immutable set search_path = public as $$
declare ra int; ga int; ba int; rb int; gb int; bb int;
begin
  if a !~* '^#[0-9a-f]{6}$' or b !~* '^#[0-9a-f]{6}$' then return 999; end if;
  ra := ('x' || substr(a, 2, 2))::bit(8)::int; ga := ('x' || substr(a, 4, 2))::bit(8)::int; ba := ('x' || substr(a, 6, 2))::bit(8)::int;
  rb := ('x' || substr(b, 2, 2))::bit(8)::int; gb := ('x' || substr(b, 4, 2))::bit(8)::int; bb := ('x' || substr(b, 6, 2))::bit(8)::int;
  return sqrt(((ra - rb) ^ 2 + (ga - gb) ^ 2 + (ba - bb) ^ 2)::numeric);
end $$;

create or replace function public.bb__team_ok(t jsonb) returns jsonb language plpgsql immutable set search_path = public as $$
begin
  if t is null or coalesce(btrim(t ->> 'name'), '') = '' then raise exception 'TEAM_NAME_REQUIRED'; end if;
  return jsonb_build_object(
    'name', left(btrim(t ->> 'name'), 40),
    'short', upper(left(btrim(coalesce(nullif(t ->> 'short', ''), left(t ->> 'name', 3))), 5)),
    'color', lower(coalesce(nullif(t ->> 'color', ''), '#00e5ff')),
    'logo', nullif(left(coalesce(t ->> 'logo', ''), 400000), ''));
end $$;

-- Rebuild score, fouls, timeouts, possession, lineups and player stats from the event log.
create or replace function public.bb__derive(m public.bb_matches) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c jsonb := m.config;
  periods int := coalesce((c ->> 'periods')::int, 4);
  per int; tfw text; tow text; kinds jsonb := coalesce(c -> 'tf_kinds', '["P","T","U","D"]'::jsonb);
  res jsonb; score jsonb; players jsonb; fouls jsonb; tos jsonb; poss text; oncourt jsonb := '{"home":[],"away":[]}'::jsonb;
  ps jsonb; un jsonb; t text; e record; arr jsonb; allow int;
begin
  select coalesce((data ->> 'to')::int, 1) into per from bb_events
    where match_id = m.id and type = 'period' and not undone order by seq desc limit 1;
  per := coalesce(per, 1);
  tfw := bb__win(per, periods, coalesce(c ->> 'tf_reset', 'period'), coalesce((c ->> 'tf_ot_continues')::boolean, true));
  tow := bb__win(per, periods, case coalesce(c ->> 'to_mode', 'halves') when 'halves' then 'halves' when 'game' then 'game' else 'period' end, false);

  select jsonb_build_object(
      'home', coalesce(sum(value) filter (where team = 'home'), 0),
      'away', coalesce(sum(value) filter (where team = 'away'), 0))
    into score from bb_events where match_id = m.id and not undone and type in ('score', 'score_adj');

  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into ps from (
    select period::text k, jsonb_build_object(
      'home', coalesce(sum(value) filter (where team = 'home'), 0),
      'away', coalesce(sum(value) filter (where team = 'away'), 0)) v
    from bb_events where match_id = m.id and not undone and type in ('score', 'score_adj') group by period) q;

  select jsonb_build_object(
      'home', coalesce(sum(value) filter (where team = 'home'), 0),
      'away', coalesce(sum(value) filter (where team = 'away'), 0))
    into un from bb_events where match_id = m.id and not undone and type = 'score' and player_id is null;

  select coalesce(jsonb_object_agg(p.id::text, jsonb_build_object(
      'pts', coalesce(s.pts, 0), 'm1', coalesce(s.m1, 0), 'm2', coalesce(s.m2, 0), 'm3', coalesce(s.m3, 0),
      'pf', coalesce(s.pf, 0), 'tf', coalesce(s.tf, 0), 'uf', coalesce(s.uf, 0), 'df', coalesce(s.df, 0),
      'fta', coalesce(s.fta, 0), 'fga', coalesce(s.fga, 0), 'reb', coalesce(s.reb, 0), 'ast', coalesce(s.ast, 0),
      'stl', coalesce(s.stl, 0), 'blk', coalesce(s.blk, 0), 'tov', coalesce(s.tov, 0),
      'fouls', coalesce(s.pf, 0) + coalesce(s.tf, 0) + coalesce(s.uf, 0) + coalesce(s.df, 0),
      'out', (coalesce(s.pf, 0) + coalesce(s.tf, 0) + coalesce(s.uf, 0) + coalesce(s.df, 0)) >= coalesce((c ->> 'pf_limit')::int, 5)
             or coalesce(s.df, 0) > 0
             or (coalesce((c ->> 'fiba_dq')::boolean, true) and (coalesce(s.uf, 0) >= 2 or coalesce(s.tf, 0) >= 2 or (coalesce(s.uf, 0) >= 1 and coalesce(s.tf, 0) >= 1))),
      'dq', coalesce(s.df, 0) > 0
             or (coalesce((c ->> 'fiba_dq')::boolean, true) and (coalesce(s.uf, 0) >= 2 or coalesce(s.tf, 0) >= 2 or (coalesce(s.uf, 0) >= 1 and coalesce(s.tf, 0) >= 1)))
    )), '{}'::jsonb) into players
  from bb_players p left join (
    select player_id,
      sum(value) filter (where type = 'score') pts,
      count(*) filter (where type = 'score' and value = 1) m1,
      count(*) filter (where type = 'score' and value = 2) m2,
      count(*) filter (where type = 'score' and value = 3) m3,
      count(*) filter (where type = 'foul' and data ->> 'kind' = 'P') pf,
      count(*) filter (where type = 'foul' and data ->> 'kind' = 'T') tf,
      count(*) filter (where type = 'foul' and data ->> 'kind' = 'U') uf,
      count(*) filter (where type = 'foul' and data ->> 'kind' = 'D') df,
      sum(value) filter (where type = 'stat' and data ->> 'key' = 'fta') fta,
      sum(value) filter (where type = 'stat' and data ->> 'key' = 'fga') fga,
      sum(value) filter (where type = 'stat' and data ->> 'key' = 'reb') reb,
      sum(value) filter (where type = 'stat' and data ->> 'key' = 'ast') ast,
      sum(value) filter (where type = 'stat' and data ->> 'key' = 'stl') stl,
      sum(value) filter (where type = 'stat' and data ->> 'key' = 'blk') blk,
      sum(value) filter (where type = 'stat' and data ->> 'key' = 'tov') tov
    from bb_events where match_id = m.id and not undone and player_id is not null group by player_id) s on s.player_id = p.id
  where p.match_id = m.id;

  select jsonb_build_object(
      'home', count(*) filter (where team = 'home'), 'away', count(*) filter (where team = 'away'))
    into fouls from bb_events
    where match_id = m.id and not undone and type = 'foul' and kinds ? (data ->> 'kind')
      and bb__win(period, periods, coalesce(c ->> 'tf_reset', 'period'), coalesce((c ->> 'tf_ot_continues')::boolean, true)) = tfw;

  allow := case coalesce(c ->> 'to_mode', 'halves')
    when 'game' then coalesce((c ->> 'to_game')::int, 5)
    when 'halves' then case tow when 'h1' then coalesce((c ->> 'to_h1')::int, 2) when 'h2' then coalesce((c ->> 'to_h2')::int, 3) else coalesce((c ->> 'to_ot')::int, 1) end
    else case when per > periods then coalesce((c ->> 'to_ot')::int, 1) else coalesce((c ->> 'to_period')::int, 1) end end;
  select jsonb_build_object(
      'allow', allow,
      'home', count(*) filter (where team = 'home'), 'away', count(*) filter (where team = 'away'))
    into tos from bb_events
    where match_id = m.id and not undone and type = 'timeout'
      and bb__win(period, periods, case coalesce(c ->> 'to_mode', 'halves') when 'halves' then 'halves' when 'game' then 'game' else 'period' end, false) = tow;

  select team into poss from bb_events where match_id = m.id and not undone and type = 'possession' order by seq desc limit 1;

  for t in select unnest(array['home', 'away']) loop
    arr := null;
    for e in select type, data from bb_events where match_id = m.id and not undone and team = t and type in ('lineup', 'sub') order by seq loop
      if e.type = 'lineup' then arr := coalesce(e.data -> 'ids', '[]'::jsonb);
      else
        arr := coalesce(arr, '[]'::jsonb);
        select coalesce(jsonb_agg(x), '[]'::jsonb) into arr from jsonb_array_elements_text(arr) x where not coalesce(e.data -> 'out', '[]'::jsonb) ? x;
        select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into arr from (select jsonb_array_elements_text(arr) x union select jsonb_array_elements_text(coalesce(e.data -> 'in', '[]'::jsonb))) q;
      end if;
    end loop;
    if arr is null then
      select coalesce(jsonb_agg(id::text order by number::int), '[]'::jsonb) into arr from bb_players where match_id = m.id and team = t and starter and active;
    end if;
    oncourt := jsonb_set(oncourt, array[t], arr);
  end loop;

  res := jsonb_build_object('score', score, 'period', per, 'period_scores', ps, 'unassigned', un, 'players', players,
    'fouls', fouls, 'penalty', jsonb_build_object(
        'home', (fouls ->> 'home')::int >= coalesce((c ->> 'tf_limit')::int, 4),
        'away', (fouls ->> 'away')::int >= coalesce((c ->> 'tf_limit')::int, 4)),
    'tos', tos, 'poss', poss, 'oncourt', oncourt);
  return res;
end $$;

-- clock helpers (ms epoch on the server)
create or replace function public.bb__now() returns bigint language sql stable set search_path = public as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;
create or replace function public.bb__left(ck jsonb, nowms bigint) returns bigint language sql immutable set search_path = public as $$
  select case when coalesce((ck ->> 'running')::boolean, false)
    then greatest(0, coalesce((ck ->> 'ms')::bigint, 0) - (nowms - coalesce((ck ->> 'at')::bigint, nowms)))
    else greatest(0, coalesce((ck ->> 'ms')::bigint, 0)) end
$$;
create or replace function public.bb__period_ms(c jsonb, per int) returns bigint language sql immutable set search_path = public as $$
  select (case when per > coalesce((c ->> 'periods')::int, 4) then coalesce((c ->> 'ot_min')::numeric, 5) else coalesce((c ->> 'period_min')::numeric, 10) end * 60000)::bigint
$$;
-- freeze clocks that ran out
create or replace function public.bb__settle(ck jsonb, nowms bigint) returns jsonb language plpgsql immutable set search_path = public as $$
declare g bigint; s bigint; sh jsonb := coalesce(ck -> 'shot', '{}'::jsonb);
begin
  g := bb__left(ck, nowms);
  if coalesce((ck ->> 'running')::boolean, false) and g = 0 then
    ck := ck || jsonb_build_object('running', false, 'ms', 0, 'at', nowms, 'ended', true);
  end if;
  s := bb__left(sh, nowms);
  if coalesce((sh ->> 'running')::boolean, false) and s = 0 then
    ck := jsonb_set(ck, '{shot}', sh || jsonb_build_object('running', false, 'ms', 0, 'at', nowms, 'expired', true));
  end if;
  return ck;
end $$;

create or replace function public.bb__snap(m public.bb_matches) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'code', m.code, 'title', m.title, 'venue', m.venue, 'starts_at', m.starts_at, 'status', m.status,
    'home', m.home, 'away', m.away, 'config', m.config, 'broadcast', m.broadcast, 'clock', m.clock, 'overlay', m.overlay,
    'derived', m.derived, 'version', m.version, 'locked', m.settings_locked, 'allow_multi', m.allow_multi,
    'can_redo', jsonb_array_length(m.redo) > 0, 'now', bb__now(), 'finalized_at', m.finalized_at, 'created_at', m.created_at,
    'players', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'team', p.team, 'number', p.number, 'first', p.first_name,
        'last', p.last_name, 'display', p.display, 'position', p.position, 'photo', p.photo, 'active', p.active, 'starter', p.starter)
        order by p.team, p.number::int), '[]'::jsonb) from bb_players p where p.match_id = m.id),
    'recent', (select coalesce(jsonb_agg(r order by r.seq desc), '[]'::jsonb) from (
        select e.id, e.seq, e.type, e.team, e.player_id, e.value, e.period, e.data, e.actor, e.undone, e.created_at
        from bb_events e where e.match_id = m.id order by e.seq desc limit 15) r),
    'devices', (select count(*) from bb_devices d where d.match_id = m.id and not d.revoked));
end $$;

create or replace function public.bb__push(m public.bb_matches, last jsonb default null) returns void language plpgsql security definer set search_path = public as $$
begin
  perform realtime.send(bb__snap(m) || jsonb_build_object('last', last), 'state', 'bb:' || m.view_key, false);
exception when others then null;  -- never fail a score because the push failed; clients re-sync on version
end $$;

-- who is calling: 'host' (signed-in owner) or a paired device role
create or replace function public.bb__role(m public.bb_matches, p_token text, out role text, out actor text) language plpgsql security definer set search_path = public, extensions as $$
declare d record;
begin
  role := null; actor := '';
  if coalesce(p_token, '') <> '' then
    select * into d from bb_devices where match_id = m.id and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
    if d.id is null then raise exception 'NOT_PAIRED'; end if;
    if d.revoked then raise exception 'REVOKED'; end if;
    update bb_devices set last_seen = now() where id = d.id and last_seen < now() - interval '30 seconds';
    role := d.role; actor := coalesce(nullif(d.name, ''), d.role);
    return;
  end if;
  if auth.uid() is not null and auth.uid() = m.owner then
    role := 'host'; actor := 'Host'; return;
  end if;
  raise exception 'NOT_AUTHORIZED';
end $$;

-- ------------------------------------------------------------------ host: create / update / roster
create or replace function public.bb_create(p jsonb) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); pr profiles; m bb_matches; c text; pl jsonb; h jsonb; a jsonb; n int := 0;
begin
  if uid is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  select * into pr from profiles where id = uid;
  if not (coalesce(pr.is_admin, false) or coalesce(pr.live_until, '-infinity') > now() or coalesce(pr.trial_until, '-infinity') > now()) then
    raise exception 'LIVE_PASS_REQUIRED';
  end if;
  h := bb__team_ok(p -> 'home'); a := bb__team_ok(p -> 'away');
  if bb__cdist(h ->> 'color', a ->> 'color') < 110 then raise exception 'COLORS_TOO_CLOSE'; end if;
  loop
    c := ''; for i in 1..6 loop c := c || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1); end loop;
    exit when not exists (select 1 from bb_matches where code = c);
    n := n + 1; if n > 20 then raise exception 'CODE_RETRY'; end if;
  end loop;
  insert into bb_matches (code, owner, view_key, pin, title, venue, starts_at, home, away, config, broadcast)
  values (c, uid, encode(gen_random_bytes(12), 'hex'), lpad((floor(random() * 1000000))::int::text, 6, '0'),
    left(coalesce(p ->> 'title', ''), 80), left(coalesce(p ->> 'venue', ''), 80), nullif(p ->> 'starts_at', '')::timestamptz,
    h, a, bb__cfg_default() || coalesce(p -> 'config', '{}'::jsonb), bb__bcast_default() || coalesce(p -> 'broadcast', '{}'::jsonb))
  returning * into m;
  for pl in select * from jsonb_array_elements(coalesce(p -> 'players', '[]'::jsonb)) loop
    insert into bb_players (match_id, team, number, first_name, last_name, display, position, photo, active, starter)
    values (m.id, pl ->> 'team', pl ->> 'number', left(coalesce(pl ->> 'first', ''), 40), left(coalesce(pl ->> 'last', ''), 40),
      left(coalesce(pl ->> 'display', ''), 40), left(coalesce(pl ->> 'position', ''), 12), nullif(left(coalesce(pl ->> 'photo', ''), 300000), ''),
      coalesce((pl ->> 'active')::boolean, true), coalesce((pl ->> 'starter')::boolean, false));
  end loop;
  update bb_matches set
    clock = jsonb_build_object('running', false, 'ms', bb__period_ms(config, 1), 'at', bb__now(),
      'shot', jsonb_build_object('running', false, 'ms', coalesce((config ->> 'shot_full')::int, 24) * 1000, 'at', bb__now())),
    overlay = jsonb_build_object('hidden', false, 'banner', null, 'reset', 0)
  where id = m.id returning * into m;
  update bb_matches set derived = bb__derive(m) where id = m.id returning * into m;
  insert into bb_audit (match_id, actor, action, detail) values (m.id, 'Host', 'create', jsonb_build_object('title', m.title));
  return jsonb_build_object('code', m.code, 'pin', m.pin, 'view_key', m.view_key);
exception when unique_violation then raise exception 'DUPLICATE_JERSEY';
end $$;

-- host reads private bits (pin, view key) of own match
create or replace function public.bb_host(p_code text) returns jsonb language plpgsql security definer set search_path = public as $$
declare m bb_matches;
begin
  select * into m from bb_matches where code = upper(p_code);
  if m.id is null then raise exception 'NO_MATCH'; end if;
  if auth.uid() is null or auth.uid() <> m.owner then raise exception 'NOT_AUTHORIZED'; end if;
  return bb__snap(m) || jsonb_build_object('pin', m.pin, 'view_key', m.view_key,
    'device_list', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'role', d.role, 'name', d.name, 'revoked', d.revoked,
       'created_at', d.created_at, 'last_seen', d.last_seen) order by d.created_at desc), '[]'::jsonb) from bb_devices d where d.match_id = m.id));
end $$;

create or replace function public.bb_update(p_code text, p jsonb) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare m bb_matches; h jsonb; a jsonb;
begin
  select * into m from bb_matches where code = upper(p_code) for update;
  if m.id is null then raise exception 'NO_MATCH'; end if;
  if auth.uid() is null or auth.uid() <> m.owner then raise exception 'NOT_AUTHORIZED'; end if;
  h := case when p ? 'home' then bb__team_ok(m.home || (p -> 'home')) else m.home end;
  a := case when p ? 'away' then bb__team_ok(m.away || (p -> 'away')) else m.away end;
  if bb__cdist(h ->> 'color', a ->> 'color') < 110 then raise exception 'COLORS_TOO_CLOSE'; end if;
  update bb_matches set
    title = case when p ? 'title' then left(p ->> 'title', 80) else title end,
    venue = case when p ? 'venue' then left(p ->> 'venue', 80) else venue end,
    starts_at = case when p ? 'starts_at' then nullif(p ->> 'starts_at', '')::timestamptz else starts_at end,
    home = h, away = a,
    config = case when p ? 'config' then config || (p -> 'config') else config end,
    broadcast = case when p ? 'broadcast' then broadcast || (p -> 'broadcast') else broadcast end,
    allow_multi = coalesce((p ->> 'allow_multi')::boolean, allow_multi),
    settings_locked = coalesce((p ->> 'locked')::boolean, settings_locked),
    pin = case when coalesce((p ->> 'new_pin')::boolean, false) then lpad((floor(random() * 1000000))::int::text, 6, '0') else pin end,
    pin_fail = case when coalesce((p ->> 'new_pin')::boolean, false) then 0 else pin_fail end,
    version = version + 1, updated_at = now()
  where id = m.id returning * into m;
  -- a changed period length resets a stopped, untouched clock
  if p ? 'config' and not coalesce((m.clock ->> 'running')::boolean, false) and m.status = 'setup' then
    update bb_matches set clock = clock || jsonb_build_object('ms', bb__period_ms(config, coalesce((derived ->> 'period')::int, 1)))
      where id = m.id returning * into m;
  end if;
  update bb_matches set derived = bb__derive(m) where id = m.id returning * into m;
  insert into bb_audit (match_id, actor, action, detail) values (m.id, 'Host', 'settings', p - 'home' - 'away' || jsonb_build_object('teams', p ? 'home' or p ? 'away'));
  perform bb__push(m);
  return bb_host(m.code);
end $$;

create or replace function public.bb_roster(p_code text, p_op text, p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare m bb_matches; pid uuid; used boolean;
begin
  select * into m from bb_matches where code = upper(p_code) for update;
  if m.id is null then raise exception 'NO_MATCH'; end if;
  if auth.uid() is null or auth.uid() <> m.owner then raise exception 'NOT_AUTHORIZED'; end if;
  if m.status = 'final' then raise exception 'MATCH_FINAL'; end if;
  begin
    if p_op = 'upsert' then
      if p ->> 'team' not in ('home', 'away') then raise exception 'BAD_TEAM'; end if;
      if coalesce(p ->> 'id', '') = '' then
        insert into bb_players (match_id, team, number, first_name, last_name, display, position, photo, active, starter)
        values (m.id, p ->> 'team', p ->> 'number', left(coalesce(p ->> 'first', ''), 40), left(coalesce(p ->> 'last', ''), 40),
          left(coalesce(p ->> 'display', ''), 40), left(coalesce(p ->> 'position', ''), 12), nullif(left(coalesce(p ->> 'photo', ''), 300000), ''),
          coalesce((p ->> 'active')::boolean, true), coalesce((p ->> 'starter')::boolean, false)) returning id into pid;
      else
        update bb_players set number = coalesce(p ->> 'number', number),
          first_name = coalesce(left(p ->> 'first', 40), first_name), last_name = coalesce(left(p ->> 'last', 40), last_name),
          display = coalesce(left(p ->> 'display', 40), display), position = coalesce(left(p ->> 'position', 12), position),
          photo = case when p ? 'photo' then nullif(left(coalesce(p ->> 'photo', ''), 300000), '') else photo end,
          active = coalesce((p ->> 'active')::boolean, active), starter = coalesce((p ->> 'starter')::boolean, starter)
        where id = (p ->> 'id')::uuid and match_id = m.id returning id into pid;
        if pid is null then raise exception 'NO_PLAYER'; end if;
      end if;
    elsif p_op = 'delete' then
      pid := (p ->> 'id')::uuid;
      select exists (select 1 from bb_events where player_id = pid) into used;
      if used then update bb_players set active = false where id = pid and match_id = m.id;   -- keep history: deactivate
      else delete from bb_players where id = pid and match_id = m.id; end if;
    else raise exception 'BAD_OP'; end if;
  exception when unique_violation then raise exception 'DUPLICATE_JERSEY';
  end;
  update bb_matches set version = version + 1, updated_at = now() where id = m.id returning * into m;
  update bb_matches set derived = bb__derive(m) where id = m.id returning * into m;
  insert into bb_audit (match_id, actor, action, detail) values (m.id, 'Host', 'roster_' || p_op, p - 'photo');
  perform bb__push(m);
  return bb_host(m.code);
end $$;

create or replace function public.bb_revoke(p_code text, p_device uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare m bb_matches;
begin
  select * into m from bb_matches where code = upper(p_code) for update;
  if m.id is null then raise exception 'NO_MATCH'; end if;
  if auth.uid() is null or auth.uid() <> m.owner then raise exception 'NOT_AUTHORIZED'; end if;
  if p_device is null then update bb_devices set revoked = true where match_id = m.id;
  else update bb_devices set revoked = true where match_id = m.id and id = p_device; end if;
  update bb_matches set version = version + 1 where id = m.id returning * into m;
  insert into bb_audit (match_id, actor, action, detail) values (m.id, 'Host', 'revoke', jsonb_build_object('device', p_device));
  perform bb__push(m, jsonb_build_object('type', 'revoke', 'device', p_device));
  return bb_host(m.code);
end $$;

create or replace function public.bb_delete(p_code text) returns void language plpgsql security definer set search_path = public as $$
begin
  delete from bb_matches where code = upper(p_code) and owner = auth.uid();
end $$;

-- ------------------------------------------------------------------ pairing (anyone with the QR + PIN)
create or replace function public.bb_pair(p_code text, p_pin text, p_role text, p_name text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare m bb_matches; tok text; did uuid; active int;
begin
  select * into m from bb_matches where code = upper(p_code) for update;
  if m.id is null then raise exception 'NO_MATCH'; end if;
  if p_role not in ('scorekeeper', 'clock', 'viewer') then raise exception 'BAD_ROLE'; end if;
  if m.pin_fail >= 8 and m.pin_fail_at > now() - interval '10 minutes' then raise exception 'PIN_LOCKED'; end if;
  if coalesce(p_pin, '') <> m.pin then
    update bb_matches set pin_fail = case when pin_fail_at > now() - interval '10 minutes' then pin_fail + 1 else 1 end, pin_fail_at = now() where id = m.id;
    return jsonb_build_object('ok', false, 'reason', 'BAD_PIN');
  end if;
  if not m.allow_multi and p_role = 'scorekeeper' then
    select count(*) into active from bb_devices where match_id = m.id and role = 'scorekeeper' and not revoked;
    if active > 0 then raise exception 'SCOREKEEPER_TAKEN'; end if;
  end if;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into bb_devices (match_id, token_hash, role, name) values (m.id, encode(digest(tok, 'sha256'), 'hex'), p_role, left(coalesce(p_name, ''), 30)) returning id into did;
  update bb_matches set pin_fail = 0, version = version + 1 where id = m.id returning * into m;
  insert into bb_audit (match_id, actor, action, detail) values (m.id, left(coalesce(p_name, p_role), 30), 'pair', jsonb_build_object('role', p_role, 'device', did));
  perform bb__push(m, jsonb_build_object('type', 'pair', 'role', p_role));
  return jsonb_build_object('ok', true, 'token', tok, 'device', did, 'role', p_role, 'view_key', m.view_key, 'snap', bb__snap(m));
end $$;

-- read-only snapshot: OBS (view key), a paired device (token) or the owner
create or replace function public.bb_snapshot(p_code text, p_key text default null, p_token text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare m bb_matches; r record;
begin
  select * into m from bb_matches where code = upper(p_code);
  if m.id is null then raise exception 'NO_MATCH'; end if;
  if coalesce(p_key, '') = m.view_key then return bb__snap(m); end if;
  select * into r from bb__role(m, p_token);
  return bb__snap(m) || jsonb_build_object('role', r.role);
end $$;

create or replace function public.bb_events(p_code text, p_key text default null, p_token text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare m bb_matches; r record;
begin
  select * into m from bb_matches where code = upper(p_code);
  if m.id is null then raise exception 'NO_MATCH'; end if;
  if coalesce(p_key, '') <> m.view_key then select * into r from bb__role(m, p_token); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'seq', e.seq, 'type', e.type, 'team', e.team, 'player_id', e.player_id,
      'value', e.value, 'period', e.period, 'data', e.data, 'actor', e.actor, 'role', e.actor_role, 'undone', e.undone,
      'edited', e.edited_at is not null, 'at', e.created_at) order by e.seq desc), '[]'::jsonb) from bb_events e where e.match_id = m.id);
end $$;

-- ------------------------------------------------------------------ THE action function
create or replace function public.bb_act(p_code text, p_token text, p_id uuid, p_type text, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m bb_matches; who record; role text; actor text; d jsonb := coalesce(p_data, '{}'::jsonb);
  v_team text := nullif(d ->> 'team', ''); v_pid uuid := nullif(d ->> 'player', '')::uuid; v int := coalesce((d ->> 'value')::int, 0);
  per int; nowms bigint := bb__now(); ck jsonb; sh jsonb; tgt bb_events; op text := d ->> 'op'; fold boolean := false;
  last jsonb; kinds text[] := array['score','score_adj','foul','timeout','period','possession','stat','lineup','sub'];
  newper int; tmp jsonb; g bigint;
begin
  if p_id is null then raise exception 'EVENT_ID_REQUIRED'; end if;
  select * into m from bb_matches where code = upper(p_code) for update;
  if m.id is null then raise exception 'NO_MATCH'; end if;
  select * into who from bb__role(m, p_token); role := who.role; actor := who.actor;

  -- duplicate tap / network retry: already applied, just return the truth
  if exists (select 1 from bb_events where id = p_id) then return bb__snap(m) || jsonb_build_object('dup', true, 'role', role); end if;

  -- permissions (enforced here, not just hidden in the UI)
  if role = 'viewer' then raise exception 'READ_ONLY'; end if;
  if role = 'clock' and p_type not in ('clock') then raise exception 'CLOCK_ONLY'; end if;
  if role = 'scorekeeper' and p_type = 'clock' and not coalesce((m.config ->> 'sk_clock')::boolean, true) then raise exception 'NO_CLOCK_RIGHTS'; end if;
  if role <> 'host' and p_type in ('final', 'reopen', 'lock') then raise exception 'HOST_ONLY'; end if;
  if role <> 'host' and p_type = 'broadcast' and m.settings_locked then raise exception 'SETTINGS_LOCKED'; end if;
  if m.status = 'final' and p_type not in ('reopen', 'overlay', 'broadcast', 'lock') then raise exception 'MATCH_FINAL'; end if;

  if v_team is not null and v_team not in ('home', 'away') then raise exception 'BAD_TEAM'; end if;
  if p_type not in ('edit', 'undo', 'redo') and v_pid is not null and not exists (select 1 from bb_players where id = v_pid and match_id = m.id and bb_players.team = v_team) then raise exception 'BAD_PLAYER'; end if;

  per := coalesce((m.derived ->> 'period')::int, 1);
  ck := bb__settle(m.clock, nowms);

  if p_type = 'score' then
    if v_team is null or v not in (1, 2, 3) then raise exception 'BAD_SCORE'; end if;
    fold := true;
  elsif p_type = 'score_adj' then
    if v_team is null or v = 0 or abs(v) > 200 then raise exception 'BAD_ADJ'; end if;
    if (m.derived -> 'score' ->> v_team)::int + v < 0 then raise exception 'NEGATIVE_SCORE'; end if;
    v_pid := null; fold := true;
  elsif p_type = 'foul' then
    if v_team is null or coalesce(d ->> 'kind', 'P') not in ('P', 'T', 'U', 'D', 'B') then raise exception 'BAD_FOUL'; end if;
    d := d || jsonb_build_object('kind', coalesce(d ->> 'kind', 'P'));
    fold := true;
  elsif p_type = 'timeout' then
    if v_team is null then raise exception 'BAD_TEAM'; end if;
    if (m.derived -> 'tos' ->> v_team)::int >= (m.derived -> 'tos' ->> 'allow')::int and not coalesce((d ->> 'force')::boolean, false) then raise exception 'NO_TIMEOUTS_LEFT'; end if;
    fold := true;
    -- stop the clock and show the banner
    g := bb__left(ck, nowms); ck := ck || jsonb_build_object('running', false, 'ms', g, 'at', nowms);
    sh := coalesce(ck -> 'shot', '{}'::jsonb); ck := jsonb_set(ck, '{shot}', sh || jsonb_build_object('running', false, 'ms', bb__left(sh, nowms), 'at', nowms));
    m.overlay := m.overlay || jsonb_build_object('banner', jsonb_build_object('id', p_id, 'kind', 'timeout', 'team', v_team,
      'text', 'TIMEOUT', 'sub', (case v_team when 'home' then m.home else m.away end) ->> 'name',
      'until', case when coalesce((d ->> 'countdown')::boolean, true) then nowms + coalesce((m.config ->> 'to_secs')::int, 60) * 1000 else null end));
  elsif p_type = 'period' then
    newper := coalesce((d ->> 'to')::int, per + 1);
    if newper < 1 or newper > coalesce((m.config ->> 'periods')::int, 4) + 10 then raise exception 'BAD_PERIOD'; end if;
    d := jsonb_build_object('to', newper, 'from', per);
    fold := true;
    ck := jsonb_build_object('running', false, 'ms', bb__period_ms(m.config, newper), 'at', nowms,
      'shot', jsonb_build_object('running', false, 'ms', coalesce((m.config ->> 'shot_full')::int, 24) * 1000, 'at', nowms));
    if m.status = 'setup' then m.status := 'live'; end if;
  elsif p_type = 'possession' then
    fold := true;   -- v_team null = clear arrow
  elsif p_type = 'stat' then
    if v_pid is null or d ->> 'key' not in ('fta', 'fga', 'reb', 'ast', 'stl', 'blk', 'tov') or v not in (1, -1) then raise exception 'BAD_STAT'; end if;
    if v < 0 and coalesce((m.derived -> 'players' -> v_pid::text ->> (d ->> 'key'))::int, 0) <= 0 then raise exception 'NEGATIVE_STAT'; end if;
    fold := true;
  elsif p_type = 'lineup' or p_type = 'sub' then
    if v_team is null then raise exception 'BAD_TEAM'; end if;
    fold := true;
  elsif p_type = 'undo' then
    if coalesce(d ->> 'target', '') <> '' then
      select * into tgt from bb_events where id = (d ->> 'target')::uuid and match_id = m.id and not undone and type = any(kinds);
    else
      select * into tgt from bb_events where match_id = m.id and not undone and type = any(kinds) order by seq desc limit 1;
    end if;
    if tgt.id is null then raise exception 'NOTHING_TO_UNDO'; end if;
    if tgt.type = 'score_adj' and (m.derived -> 'score' ->> tgt.team)::int - tgt.value < 0 then raise exception 'NEGATIVE_SCORE'; end if;
    update bb_events set undone = true, undone_at = now() where id = tgt.id;
    d := jsonb_build_object('target', tgt.id, 'what', tgt.type, 'team', tgt.team, 'value', tgt.value, 'player', tgt.player_id, 'kind', tgt.data ->> 'kind');
    v_team := tgt.team; v_pid := tgt.player_id; v := tgt.value;
    m.redo := m.redo || to_jsonb(tgt.id::text);
    if tgt.type = 'period' then
      newper := coalesce((tgt.data ->> 'from')::int, 1);
      ck := jsonb_build_object('running', false, 'ms', bb__period_ms(m.config, newper), 'at', nowms,
        'shot', jsonb_build_object('running', false, 'ms', coalesce((m.config ->> 'shot_full')::int, 24) * 1000, 'at', nowms));
    end if;
    if tgt.type = 'timeout' and (m.overlay -> 'banner' ->> 'id') = tgt.id::text then m.overlay := m.overlay || jsonb_build_object('banner', null); end if;
  elsif p_type = 'redo' then
    if jsonb_array_length(m.redo) = 0 then raise exception 'NOTHING_TO_REDO'; end if;
    select * into tgt from bb_events where id = (m.redo ->> (jsonb_array_length(m.redo) - 1))::uuid and match_id = m.id;
    m.redo := m.redo - (jsonb_array_length(m.redo) - 1);
    if tgt.id is null or not tgt.undone then raise exception 'NOTHING_TO_REDO'; end if;
    update bb_events set undone = false, undone_at = null where id = tgt.id;
    d := jsonb_build_object('target', tgt.id, 'what', tgt.type); v_team := tgt.team; v_pid := tgt.player_id; v := tgt.value;
  elsif p_type = 'edit' then
    select * into tgt from bb_events where id = (d ->> 'target')::uuid and match_id = m.id and type = any(array['score', 'foul', 'stat']);
    if tgt.id is null then raise exception 'BAD_TARGET'; end if;
    if d ? 'player' and nullif(d ->> 'player', '') is not null and not exists (select 1 from bb_players where id = (d ->> 'player')::uuid and match_id = m.id and bb_players.team = tgt.team) then raise exception 'BAD_PLAYER'; end if;
    if tgt.type = 'score' and d ? 'value' and (d ->> 'value')::int not in (1, 2, 3) then raise exception 'BAD_SCORE'; end if;
    if d ? 'kind' and d ->> 'kind' not in ('P', 'T', 'U', 'D', 'B') then raise exception 'BAD_FOUL'; end if;
    update bb_events set
      player_id = case when d ? 'player' then nullif(d ->> 'player', '')::uuid else player_id end,
      value = case when d ? 'value' and tgt.type = 'score' then (d ->> 'value')::int else value end,
      data = case when d ? 'kind' and tgt.type = 'foul' then data || jsonb_build_object('kind', d ->> 'kind') else data end,
      edited_at = now()
    where id = tgt.id;
    d := jsonb_build_object('target', tgt.id, 'what', tgt.type, 'before', jsonb_build_object('player', tgt.player_id, 'value', tgt.value, 'kind', tgt.data ->> 'kind'), 'after', d - 'target');
    v_team := tgt.team; v_pid := null; v := 0;
  elsif p_type = 'clock' then
    sh := coalesce(ck -> 'shot', '{}'::jsonb);
    if op = 'start' then
      if bb__left(ck, nowms) = 0 then raise exception 'CLOCK_AT_ZERO'; end if;
      ck := ck || jsonb_build_object('running', true, 'ms', bb__left(ck, nowms), 'at', nowms, 'ended', false);
      if coalesce((m.config ->> 'shot_on')::boolean, true) and bb__left(sh, nowms) > 0 then
        ck := jsonb_set(ck, '{shot}', sh || jsonb_build_object('running', true, 'ms', bb__left(sh, nowms), 'at', nowms, 'expired', false));
      end if;
      if m.status = 'setup' then m.status := 'live'; end if;
    elsif op = 'pause' or op = 'emergency' then
      ck := ck || jsonb_build_object('running', false, 'ms', bb__left(ck, nowms), 'at', nowms);
      ck := jsonb_set(ck, '{shot}', sh || jsonb_build_object('running', false, 'ms', bb__left(sh, nowms), 'at', nowms));
    elsif op = 'set' then
      g := greatest(0, least((d ->> 'ms')::bigint, 3600000));
      ck := ck || jsonb_build_object('running', coalesce((ck ->> 'running')::boolean, false) and g > 0, 'ms', g, 'at', nowms, 'ended', g = 0);
    elsif op = 'reset' then
      ck := ck || jsonb_build_object('running', false, 'ms', bb__period_ms(m.config, per), 'at', nowms, 'ended', false);
    elsif op = 'shot_reset' then
      g := coalesce((d ->> 'secs')::int, (m.config ->> 'shot_full')::int, 24) * 1000;
      ck := jsonb_set(ck, '{shot}', sh || jsonb_build_object('ms', g, 'at', nowms, 'expired', false,
        'running', coalesce((ck ->> 'running')::boolean, false)));
    elsif op = 'shot_start' then
      ck := jsonb_set(ck, '{shot}', sh || jsonb_build_object('running', bb__left(sh, nowms) > 0, 'ms', bb__left(sh, nowms), 'at', nowms));
    elsif op = 'shot_pause' then
      ck := jsonb_set(ck, '{shot}', sh || jsonb_build_object('running', false, 'ms', bb__left(sh, nowms), 'at', nowms));
    elsif op = 'shot_set' then
      ck := jsonb_set(ck, '{shot}', sh || jsonb_build_object('ms', greatest(0, least((d ->> 'ms')::bigint, 99000)), 'at', nowms, 'expired', false));
    elsif op = 'shot_off' then
      ck := jsonb_set(ck, '{shot}', sh || jsonb_build_object('running', false, 'ms', bb__left(sh, nowms), 'at', nowms, 'hidden', not coalesce((sh ->> 'hidden')::boolean, false)));
    else raise exception 'BAD_CLOCK_OP'; end if;
    d := d || jsonb_build_object('game_ms', bb__left(ck, nowms));
  elsif p_type = 'overlay' then
    if op = 'reset' then m.overlay := m.overlay || jsonb_build_object('banner', null, 'hidden', false, 'reset', coalesce((m.overlay ->> 'reset')::int, 0) + 1);
    elsif op = 'hide' then m.overlay := m.overlay || jsonb_build_object('hidden', true);
    elsif op = 'show' then m.overlay := m.overlay || jsonb_build_object('hidden', false);
    elsif op = 'clear' then m.overlay := m.overlay || jsonb_build_object('banner', null);
    elsif op = 'banner' then
      if coalesce(btrim(d ->> 'text'), '') = '' then raise exception 'TEXT_REQUIRED'; end if;
      m.overlay := m.overlay || jsonb_build_object('banner', jsonb_build_object('id', p_id, 'kind', coalesce(d ->> 'kind', 'break'),
        'text', left(upper(d ->> 'text'), 40), 'sub', left(coalesce(d ->> 'sub', ''), 60), 'team', v_team,
        'until', case when coalesce((d ->> 'secs')::int, 0) > 0 then nowms + (d ->> 'secs')::int * 1000 else null end));
    else raise exception 'BAD_OVERLAY_OP'; end if;
  elsif p_type = 'broadcast' then
    if d ? 'home' or d ? 'away' then
      tmp := case when d ? 'home' then bb__team_ok(m.home || (d -> 'home')) else m.home end;
      if bb__cdist(tmp ->> 'color', (case when d ? 'away' then bb__team_ok(m.away || (d -> 'away')) else m.away end) ->> 'color') < 110 then raise exception 'COLORS_TOO_CLOSE'; end if;
      m.home := tmp; if d ? 'away' then m.away := bb__team_ok(m.away || (d -> 'away')); end if;
    end if;
    if d ? 'patch' then m.broadcast := m.broadcast || (d -> 'patch'); end if;
    if d ? 'timer_mode' and d ->> 'timer_mode' in ('digital', 'external') then m.config := m.config || jsonb_build_object('timer_mode', d ->> 'timer_mode'); end if;
    d := d - 'home' - 'away' || jsonb_build_object('teams', d ? 'home' or d ? 'away');
  elsif p_type = 'lock' then
    m.settings_locked := coalesce((d ->> 'on')::boolean, not m.settings_locked);
  elsif p_type = 'final' then
    ck := ck || jsonb_build_object('running', false, 'ms', bb__left(ck, nowms), 'at', nowms);
    m.status := 'final'; m.finalized_at := now();
    m.overlay := m.overlay || jsonb_build_object('hidden', false, 'banner', jsonb_build_object('id', p_id, 'kind', 'final', 'text', 'FINAL', 'until', null));
  elsif p_type = 'reopen' then
    m.status := 'live'; m.finalized_at := null; m.overlay := m.overlay || jsonb_build_object('banner', null);
  else
    raise exception 'BAD_TYPE';
  end if;

  if fold then m.redo := '[]'::jsonb; end if;
  m.seq := m.seq + 1;
  insert into bb_events (id, match_id, seq, type, team, player_id, value, period, data, actor, actor_role)
  values (p_id, m.id, m.seq, p_type, v_team, v_pid, v, per, d, actor, role);

  update bb_matches set clock = ck, overlay = m.overlay, status = m.status, finalized_at = m.finalized_at, redo = m.redo,
    home = m.home, away = m.away, broadcast = m.broadcast, config = m.config, settings_locked = m.settings_locked,
    seq = m.seq, version = version + 1, updated_at = now()
  where id = m.id returning * into m;
  if fold or p_type in ('undo', 'redo', 'edit') then
    update bb_matches set derived = bb__derive(m) where id = m.id returning * into m;
  end if;
  if p_type in ('score_adj', 'edit', 'undo', 'redo', 'final', 'reopen', 'lock') or (p_type = 'clock' and op in ('set', 'reset', 'shot_set')) then
    insert into bb_audit (match_id, actor, action, detail) values (m.id, actor || ' (' || role || ')', p_type, d);
  end if;

  last := jsonb_build_object('id', p_id, 'type', p_type, 'team', v_team, 'player', v_pid, 'value', v, 'data', d, 'actor', actor);
  perform bb__push(m, last);
  return bb__snap(m) || jsonb_build_object('role', role, 'last', last);
end $$;

-- ------------------------------------------------------------------ grants
revoke all on function public.bb_create(jsonb), public.bb_host(text), public.bb_update(text, jsonb), public.bb_roster(text, text, jsonb),
  public.bb_revoke(text, uuid), public.bb_delete(text) from public, anon;
grant execute on function public.bb_create(jsonb), public.bb_host(text), public.bb_update(text, jsonb), public.bb_roster(text, text, jsonb),
  public.bb_revoke(text, uuid), public.bb_delete(text) to authenticated;
grant execute on function public.bb_pair(text, text, text, text), public.bb_snapshot(text, text, text), public.bb_events(text, text, text),
  public.bb_act(text, text, uuid, text, jsonb) to anon, authenticated;
revoke all on function public.bb__derive(public.bb_matches), public.bb__snap(public.bb_matches), public.bb__push(public.bb_matches, jsonb),
  public.bb__role(public.bb_matches, text) from public, anon, authenticated;
