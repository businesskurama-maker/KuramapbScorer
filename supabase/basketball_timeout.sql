-- Timeouts: end early ('timeout_end', any scorer or the timer operator) and end automatically when play resumes (clock start).
-- The used timeout still counts. Applied as a patch of the live bb_act.
do $$ declare d text; begin
  d := pg_get_functiondef('public.bb_act(text,text,uuid,text,jsonb)'::regprocedure);
  d := replace(d, $x$if role = 'clock' and p_type not in ('clock') then raise exception 'CLOCK_ONLY'; end if;$x$,
                  $x$if role = 'clock' and p_type not in ('clock', 'timeout_end') then raise exception 'CLOCK_ONLY'; end if;$x$);
  d := replace(d, $x$  elsif p_type = 'period' then$x$, $x$  elsif p_type = 'timeout_end' then
    -- end a running timeout early (the count stays used); the clock does not move
    if (m.overlay -> 'banner' ->> 'kind') = 'timeout' then m.overlay := m.overlay || jsonb_build_object('banner', null); end if;
  elsif p_type = 'period' then$x$);
  d := replace(d, $x$    if op = 'start' then
      if bb__left(ck, nowms) = 0 then raise exception 'CLOCK_AT_ZERO'; end if;$x$, $x$    if op = 'start' then
      if bb__left(ck, nowms) = 0 then raise exception 'CLOCK_AT_ZERO'; end if;
      if (m.overlay -> 'banner' ->> 'kind') = 'timeout' then m.overlay := m.overlay || jsonb_build_object('banner', null); end if;   -- play resumes: timeout over$x$);
  if position('timeout_end'' then' in d) = 0 or position('play resumes' in d) = 0 then raise exception 'patch failed'; end if;
  execute d;
end $$;
