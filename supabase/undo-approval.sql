-- Already applied to the live project. Kept here for reference.
-- Undo an accidental approval: take the hours back and return the donation to "Donations to confirm".
-- Hours come first from the user's unused time bank, then from their running pass. Time already played can't be taken back.
create or replace function public.admin_undo_approval(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pu public.purchases; pr public.profiles; from_bank int := 0; from_pass int := 0; rem int; new_until timestamptz;
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into pu from public.purchases where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pu.status <> 'approved' then raise exception 'NOT_APPROVED'; end if;
  select * into pr from public.profiles where id = pu.user_id for update;
  from_bank := least(greatest(pr.hours_balance, 0), pu.hours);
  rem := pu.hours - from_bank;
  new_until := pr.pass_until;
  if rem > 0 and pr.pass_until is not null and pr.pass_until > now() then
    from_pass := least(rem, ceil(extract(epoch from (pr.pass_until - now())) / 3600.0)::int);
    new_until := greatest(now(), pr.pass_until - make_interval(hours => rem));
  end if;
  update public.profiles set hours_balance = hours_balance - from_bank, pass_until = new_until where id = pr.id;
  update public.purchases set status = 'pending', reviewed_by = null, reviewed_at = null,
    note = 'Approval undone by owner ' || to_char(now() at time zone 'Asia/Manila', 'Mon DD HH12:MI AM') where id = p_id;
  if from_bank + from_pass > 0 then
    insert into public.credit_ledger(user_id, delta, reason, created_by)
    values (pu.user_id, -(from_bank + from_pass), 'Approval undone · purchase #' || pu.id || ' ref ' || pu.reference, auth.uid());
  end if;
  return jsonb_build_object('hours', pu.hours, 'from_bank', from_bank, 'from_pass', from_pass,
    'used', greatest(pu.hours - from_bank - from_pass, 0), 'pass_until', new_until, 'pass_ended', new_until is not null and new_until <= now());
end $$;
revoke all on function public.admin_undo_approval(bigint) from public, anon;
grant execute on function public.admin_undo_approval(bigint) to authenticated;
