-- Basketball LIVE OBS pass: 1-day free pass for new users, donation packages, admin pass codes.
alter table public.profiles add column if not exists bb_until timestamptz;
update public.profiles set bb_until = now() + interval '1 day' where bb_until is null;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  insert into public.profiles (id, email, full_name, avatar_url, is_admin, trial_until, bb_until)
  values (
    new.id, lower(new.email),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url',
    exists (select 1 from public.admin_emails a where a.email = lower(new.email)),
    now() + interval '1 month',
    now() + interval '1 day'            -- Basketball LIVE OBS: 1-day free pass
  )
  on conflict (id) do nothing;
  return new;
end $function$;

alter table public.packages drop constraint if exists packages_kind_check;
alter table public.packages add constraint packages_kind_check check (kind in ('solo', 'live', 'bb'));

insert into public.packages (code, label, hours, price_php, sort, kind) values
  ('bb1d', 'Basketball · 1 day', 24, 150, 20, 'bb'),
  ('bb3d', 'Basketball · 3 days', 72, 300, 21, 'bb'),
  ('bb1w', 'Basketball · 1 week', 168, 500, 22, 'bb')
on conflict (code) do nothing;

create or replace function public.admin_review_purchase(p_id bigint, p_approve boolean, p_note text default null::text)
returns text language plpgsql security definer set search_path to 'public' as $function$
declare pu public.purchases; k text;
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into pu from public.purchases where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pu.status <> 'pending' then raise exception 'ALREADY_REVIEWED'; end if;
  select kind into k from public.packages where code = pu.package;
  update public.purchases set status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by = auth.uid(), reviewed_at = now(), note = nullif(trim(p_note),'') where id = p_id;
  if p_approve then
    if k = 'live' then
      update public.profiles set live_hours = live_hours + pu.hours where id = pu.user_id;
    elsif k = 'bb' then
      update public.profiles set bb_until = greatest(coalesce(bb_until, now()), now()) + make_interval(hours => pu.hours) where id = pu.user_id;
    else
      update public.profiles set hours_balance = hours_balance + pu.hours where id = pu.user_id;
    end if;
    insert into public.credit_ledger(user_id, delta, reason, created_by)
    values (pu.user_id, pu.hours, case when k = 'live' then 'LIVE · ' when k = 'bb' then 'BASKETBALL · ' else '' end || 'Purchase #' || pu.id || ' ' || pu.package || ' PHP ' || pu.amount_php || ' ref ' || pu.reference, auth.uid());
  end if;
  return case when p_approve then 'approved' else 'rejected' end;
end $function$;

create or replace function public.admin_undo_approval(p_id bigint) returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare pu public.purchases; pr public.profiles; k text; bank int; until_ts timestamptz;
  from_bank int := 0; from_pass int := 0; rem int; new_until timestamptz;
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into pu from public.purchases where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pu.status <> 'approved' then raise exception 'NOT_APPROVED'; end if;
  select kind into k from public.packages where code = pu.package;
  select * into pr from public.profiles where id = pu.user_id for update;
  if k = 'bb' then
    until_ts := pr.bb_until;
    new_until := greatest(now(), coalesce(until_ts, now()) - make_interval(hours => pu.hours));
    from_pass := case when until_ts is null or until_ts <= now() then 0 else least(pu.hours, ceil(extract(epoch from (until_ts - now())) / 3600.0)::int) end;
    update public.profiles set bb_until = new_until where id = pr.id;
  else
    bank := case when k = 'live' then pr.live_hours else pr.hours_balance end;
    until_ts := case when k = 'live' then pr.live_until else pr.pass_until end;
    from_bank := least(greatest(bank, 0), pu.hours);
    rem := pu.hours - from_bank;
    new_until := until_ts;
    if rem > 0 and until_ts is not null and until_ts > now() then
      from_pass := least(rem, ceil(extract(epoch from (until_ts - now())) / 3600.0)::int);
      new_until := greatest(now(), until_ts - make_interval(hours => rem));
    end if;
    if k = 'live' then
      update public.profiles set live_hours = live_hours - from_bank, live_until = new_until where id = pr.id;
    else
      update public.profiles set hours_balance = hours_balance - from_bank, pass_until = new_until where id = pr.id;
    end if;
  end if;
  update public.purchases set status = 'pending', reviewed_by = null, reviewed_at = null,
    note = 'Approval undone by owner ' || to_char(now() at time zone 'Asia/Manila', 'Mon DD HH12:MI AM') where id = p_id;
  if from_bank + from_pass > 0 then
    insert into public.credit_ledger(user_id, delta, reason, created_by)
    values (pu.user_id, -(from_bank + from_pass), case when k = 'live' then 'LIVE · ' when k = 'bb' then 'BASKETBALL · ' else '' end || 'Approval undone · purchase #' || pu.id || ' ref ' || pu.reference, auth.uid());
  end if;
  return jsonb_build_object('hours', pu.hours, 'from_bank', from_bank, 'from_pass', from_pass,
    'used', greatest(pu.hours - from_bank - from_pass, 0), 'pass_until', new_until, 'pass_ended', new_until is not null and new_until <= now(), 'live', k = 'live', 'bb', k = 'bb');
end $function$;

-- admin-issued Basketball pass codes (1 day / 3 days / 1 week)
create table if not exists public.bb_codes (
  code text primary key,
  days int not null check (days in (1, 3, 7)),
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  redeemed_by uuid references auth.users(id) on delete set null,
  redeemed_email text,
  redeemed_at timestamptz,
  revoked boolean not null default false
);
alter table public.bb_codes enable row level security;
drop policy if exists bb_codes_admin on public.bb_codes;
create policy bb_codes_admin on public.bb_codes for select to authenticated using ((select public.is_admin()));
revoke insert, update, delete on public.bb_codes from anon, authenticated;
revoke select on public.bb_codes from anon;

create or replace function public.admin_create_bb_code(p_days int, p_note text default null) returns text language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; c text;
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  if p_days not in (1, 3, 7, 30, 90, 150) then raise exception 'BAD_DAYS'; end if;
  loop
    c := 'BB';
    for i in 1..8 loop c := c || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % length(alphabet)), 1); end loop;
    exit when not exists (select 1 from public.bb_codes where code = c);
  end loop;
  insert into public.bb_codes(code, days, note, created_by) values (c, p_days, nullif(trim(p_note), ''), auth.uid());
  return c;
end $$;

create or replace function public.admin_revoke_bb_code(p_code text) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  update public.bb_codes set revoked = true where code = upper(p_code) and redeemed_at is null;
end $$;

create or replace function public.redeem_bb_code(p_code text) returns timestamptz language plpgsql security definer set search_path to 'public' as $$
declare bc public.bb_codes; k text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); u timestamptz;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  select * into bc from public.bb_codes where code = k for update;
  if not found or bc.revoked then raise exception 'BAD_CODE'; end if;
  if bc.redeemed_at is not null then raise exception 'USED_CODE'; end if;
  if bc.expires_at < now() then raise exception 'EXPIRED_CODE'; end if;
  update public.profiles set bb_until = greatest(coalesce(bb_until, now()), now()) + make_interval(days => bc.days) where id = auth.uid() returning bb_until into u;
  update public.bb_codes set redeemed_by = auth.uid(), redeemed_email = (select email from public.profiles where id = auth.uid()), redeemed_at = now() where code = k;
  insert into public.credit_ledger(user_id, delta, reason, created_by) values (auth.uid(), bc.days * 24, 'BASKETBALL · pass code ' || k, auth.uid());
  return u;
end $$;

revoke all on function public.admin_create_bb_code(int, text), public.admin_revoke_bb_code(text), public.redeem_bb_code(text) from public, anon;
grant execute on function public.admin_create_bb_code(int, text), public.admin_revoke_bb_code(text), public.redeem_bb_code(text) to authenticated;

-- creating basketball matches needs an active Basketball pass (owner/admin always allowed)
create or replace function public.bb_pass_ok(uid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin or coalesce(bb_until, '-infinity') > now() from profiles where id = uid), false)
$$;
revoke all on function public.bb_pass_ok(uuid) from public, anon, authenticated;
do $$ declare d text; begin
  d := pg_get_functiondef('public.bb_create(jsonb)'::regprocedure);
  d := replace(d, 'if not (coalesce(pr.is_admin, false) or coalesce(pr.live_until, ''-infinity'') > now() or coalesce(pr.trial_until, ''-infinity'') > now()) then', 'if not public.bb_pass_ok(uid) then');
  if position('bb_pass_ok' in d) = 0 then raise exception 'patch failed'; end if;
  execute d;
end $$;

-- owner can delete finished codes (used, cancelled or expired). Unused live codes must be cancelled first.
-- Deleting a used code never touches the pass it already gave (profiles.bb_until).
create or replace function public.admin_delete_bb_codes(p_codes text[]) returns int language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  delete from public.bb_codes where code = any (select upper(x) from unnest(p_codes) x)
    and (redeemed_at is not null or revoked or expires_at < now());
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.admin_delete_bb_codes(text[]) from public, anon;
grant execute on function public.admin_delete_bb_codes(text[]) to authenticated;

-- monthly pass codes: 1 month (30 days), 3 months (90), 5 months (150)
alter table public.bb_codes drop constraint if exists bb_codes_days_check;
alter table public.bb_codes add constraint bb_codes_days_check check (days = any (array[1, 3, 7, 30, 90, 150]));
