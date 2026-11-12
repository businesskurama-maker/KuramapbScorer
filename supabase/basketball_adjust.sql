-- Manual corrections by the scorer: team timeouts used ('to'), team fouls this period ('tf'), a player's personal fouls ('pf').
-- Stored as 'adjust' events (value +1 / -1) so they show in the log and can be undone like anything else.
do $$ declare d text; begin
  d := pg_get_functiondef('public.bb_act(text,text,uuid,text,jsonb)'::regprocedure);
  d := replace(d, $x$kinds text[] := array['score','score_adj','foul','timeout','period','possession','stat','lineup','sub'];$x$,
                  $x$kinds text[] := array['score','score_adj','foul','timeout','period','possession','stat','lineup','sub','adjust'];$x$);
  d := replace(d, $x$  elsif p_type = 'stat' then$x$, $x$  elsif p_type = 'adjust' then
    if v_team is null or coalesce(d ->> 'k', '') not in ('to', 'tf', 'pf') or v not in (1, -1) then raise exception 'BAD_ADJUST'; end if;
    if d ->> 'k' = 'pf' then
      if v_pid is null then raise exception 'BAD_PLAYER'; end if;
      if v < 0 and coalesce((m.derived -> 'players' -> v_pid::text ->> 'pf')::int, 0) <= 0 then raise exception 'NEGATIVE_STAT'; end if;
    else
      v_pid := null;
      if v < 0 and coalesce((m.derived -> (case d ->> 'k' when 'to' then 'tos' else 'fouls' end) ->> v_team)::int, 0) <= 0 then raise exception 'NEGATIVE_STAT'; end if;
    end if;
    d := jsonb_build_object('k', d ->> 'k');
    fold := true;
  elsif p_type = 'stat' then$x$);
  if position('BAD_ADJUST' in d) = 0 or position('''sub'',''adjust''' in d) = 0 then raise exception 'bb_act patch failed'; end if;
  execute d;

  d := pg_get_functiondef('public.bb__derive(public.bb_matches)'::regprocedure);
  d := replace(d, $x$count(*) filter (where type = 'foul' and data ->> 'kind' = 'P') pf,$x$,
                  $x$greatest(0, count(*) filter (where type = 'foul' and data ->> 'kind' = 'P') + coalesce(sum(value) filter (where type = 'adjust' and data ->> 'k' = 'pf'), 0)) pf,$x$);
  d := replace(d, $x$'home', count(*) filter (where team = 'home'), 'away', count(*) filter (where team = 'away'))$x$,
                  $x$'home', greatest(0, coalesce(sum(case when type = 'adjust' then value else 1 end) filter (where team = 'home'), 0)), 'away', greatest(0, coalesce(sum(case when type = 'adjust' then value else 1 end) filter (where team = 'away'), 0)))$x$);
  d := replace(d, $x$and not undone and type = 'foul' and kinds ? (data ->> 'kind')$x$,
                  $x$and not undone and ((type = 'foul' and kinds ? (data ->> 'kind')) or (type = 'adjust' and data ->> 'k' = 'tf'))$x$);
  d := replace(d, $x$and not undone and type = 'timeout'$x$,
                  $x$and not undone and (type = 'timeout' or (type = 'adjust' and data ->> 'k' = 'to'))$x$);
  if position('data ->> ''k'' = ''tf''' in d) = 0 or position('data ->> ''k'' = ''to''' in d) = 0 or position('data ->> ''k'' = ''pf''' in d) = 0 then raise exception 'derive patch failed'; end if;
  execute d;
end $$;
