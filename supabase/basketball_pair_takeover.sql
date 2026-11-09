-- Pairing with the correct PIN takes over the single scorekeeper slot (old phone is revoked and notified)
-- instead of failing with SCOREKEEPER_TAKEN. Applied as migration bb_pair_takeover (patches bb_pair in place).
do $$ declare d text; begin
  d := pg_get_functiondef('public.bb_pair(text,text,text,text)'::regprocedure);
  d := replace(d, $x$    if active > 0 then raise exception 'SCOREKEEPER_TAKEN'; end if;$x$,
$x$    -- the correct PIN proves the right to score: the new phone takes over the single scorekeeper slot
    if active > 0 then
      update bb_devices set revoked = true where match_id = m.id and role = 'scorekeeper' and not revoked;
      insert into bb_audit (match_id, actor, action, detail) values (m.id, left(coalesce(p_name, p_role), 30), 'takeover', jsonb_build_object('role', p_role, 'replaced', active));
      perform bb__push(m, jsonb_build_object('type', 'revoke', 'role', 'scorekeeper', 'takeover', true));
    end if;$x$);
  if position('takeover' in d) = 0 then raise exception 'patch failed'; end if;
  execute d;
end $$;
