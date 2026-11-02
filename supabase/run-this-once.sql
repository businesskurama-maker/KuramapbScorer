-- Run once in Supabase → SQL Editor (project kurama_pickleball_scorer).
-- Payments use the LAST 6 DIGITS of the InstaPay reference; duplicates across users are allowed (the owner checks).
drop index if exists public.purchases_reference_uniq;
create index if not exists purchases_reference_idx on public.purchases(reference);

create or replace function public.request_purchase(p_package text, p_reference text)
returns bigint language plpgsql security definer set search_path = public as $$
declare pk public.packages; rid bigint; ref text := regexp_replace(coalesce(p_reference,''), '\D', '', 'g');
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN'; end if;
  if length(ref) <> 6 then raise exception 'BAD_REFERENCE'; end if;
  select * into pk from public.packages where code = p_package;
  if not found then raise exception 'BAD_PACKAGE'; end if;
  if (select count(*) from public.purchases where user_id = auth.uid() and status = 'pending') >= 3 then raise exception 'TOO_MANY_PENDING'; end if;
  if exists (select 1 from public.purchases where user_id = auth.uid() and reference = ref and status <> 'rejected') then raise exception 'DUPLICATE_REFERENCE'; end if;
  insert into public.purchases(user_id, package, hours, amount_php, reference)
  values (auth.uid(), pk.code, pk.hours, pk.price_php, ref) returning id into rid;
  return rid;
end $$;
revoke all on function public.request_purchase(text,text) from public, anon;
grant execute on function public.request_purchase(text,text) to authenticated;
