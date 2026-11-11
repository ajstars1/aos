-- Phase B, part 3: the touch cap is the person's own setting.
-- aos cannot see replies, so it cannot tell cold outreach from a conversation. The person decides: how many emails
-- one address may get from them in 30 days (default 2, 0 = no cap). Only the person can change it, on /app; a token
-- issued to a connected app is refused, so an assistant can never lift the cap it is held to.

alter table profiles add column touch_cap smallint not null default 2 check (touch_cap between 0 and 20);

create or replace function guard_profile() returns trigger language plpgsql set search_path = '' as $$
begin
  if (auth.jwt() ->> 'client_id') is not null then
    if tg_op = 'INSERT' then
      new.mask_level := 'api';
      new.touch_cap := 2;
    elsif new.mask_level is distinct from old.mask_level then
      raise exception 'Only the person can change privacy settings, in the aos app. An assistant cannot.';
    elsif new.touch_cap is distinct from old.touch_cap then
      raise exception 'Only the person can change the email cap, in the aos app. An assistant cannot.';
    end if;
  end if;
  return new;
end $$;

create or replace function touch_block(p_user uuid, p_recipient text) returns text language plpgsql stable security definer set search_path = '' as $$
declare
  k text := public.recipient_key(p_recipient);
  cap integer;
  n integer;
  oldest timestamptz;
begin
  select p.touch_cap into cap from public.profiles p where p.user_id = p_user and p.deleted_at is null;
  cap := coalesce(cap, 2);
  if k is null or cap = 0 then
    return null;
  end if;
  select count(*), min(at) into n, oldest from public.touches
   where user_id = p_user and recipient_key = k and at > now() - interval '30 days';
  if n >= cap then
    return format('Blocked: %s already got %s emails from you in the last 30 days (your cap is %s). '
                  'It stays approved; Send now works again after %s, or raise the cap on your aos page',
                  k, n, cap, to_char(oldest + interval '30 days', 'YYYY-MM-DD'));
  end if;
  return null;
end $$;

revoke all on function touch_block(uuid, text) from public, anon, authenticated, service_role;
