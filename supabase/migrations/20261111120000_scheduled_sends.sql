-- Phase B, part 1: aos sends scheduled emails by itself, and a per-recipient touch cap.
--
-- Scheduled sends: a timer (the cron route) asks cron_due_sends() for approved emails whose send_after has passed
-- and sends each one through the same sealed path as a yes on /app: send_claim() / send_finish(). So "at most once"
-- and "50 a day" hold exactly as before. The timer gives up on a draft after 3 tries; the person can still press
-- Send now.
--
-- Touch cap: a touch is one approved draft to one email address that went out (or may have: 'failed'). The
-- database records it in `touches` when the draft is marked sent or failed, whoever marked it (aos, or an assistant
-- through mark_approval_sent). Nobody but the database writes or reads that table. send_claim() refuses a third
-- touch to the same address within 30 days: the draft stays approved and its result says why.

-- ---------------------------------------------------------------------------------------------------------------
-- approvals: how often the server took a draft for sending
-- ---------------------------------------------------------------------------------------------------------------

alter table approvals add column send_tries smallint not null default 0 check (send_tries between 0 and 1000);

create or replace function guard_approval() returns trigger language plpgsql set search_path = '' as $$
declare
  from_app boolean := (auth.jwt() ->> 'client_id') is not null;
  direct boolean := current_user in ('authenticated', 'anon');
  content_changed boolean;
begin
  if tg_op = 'INSERT' then
    -- an API request can only come in through request_action(), never as a hand-written row
    if direct and (new.action is not null or new.channel = 'api') then
      raise exception 'An API request must be asked with api_request';
    end if;
    new.status := 'pending';
    new.decided_at := null;
    new.result := null;
    new.send_claimed_at := null;
    new.send_tries := 0;
    return new;
  end if;

  if new.user_id is distinct from old.user_id or new.id is distinct from old.id then
    raise exception 'An approval cannot change owner';
  end if;

  content_changed := new.draft is distinct from old.draft
      or new.subject is distinct from old.subject
      or new.recipient is distinct from old.recipient
      or new.channel is distinct from old.channel
      or new.send_after is distinct from old.send_after
      or new.action is distinct from old.action;

  if content_changed and old.status <> 'pending' then
    raise exception 'Only a pending draft can be edited (approval % is %)', old.id, old.status;
  end if;
  -- Otherwise an app could swap the text between the moment the person reads it and the moment they press yes.
  if content_changed and from_app then
    raise exception 'An assistant cannot change a draft after asking. Ask again with the new text.';
  end if;
  if content_changed and direct and (old.action is not null or new.action is not null or new.channel = 'api') then
    raise exception 'An API request cannot be edited. Reject it and ask again.';
  end if;

  if (new.send_claimed_at is distinct from old.send_claimed_at or new.send_tries is distinct from old.send_tries) and direct then
    raise exception 'Only the aos server can claim a send';
  end if;

  if new.status is distinct from old.status then
    if new.status in ('approved', 'rejected') then
      if from_app then
        raise exception 'Only the person can approve or reject, in the aos app. An assistant cannot.';
      end if;
      if old.status <> 'pending' then
        raise exception 'Approval % is already %', old.id, old.status;
      end if;
      new.decided_at := now();
    elsif new.status in ('sent', 'failed') then
      if old.status <> 'approved' then
        raise exception 'Only an approved draft can be marked sent (approval % is %)', old.id, old.status;
      end if;
      if direct and old.action is not null then
        raise exception 'Only aos can run an API request';
      end if;
    else
      raise exception 'An approval cannot go back to pending';
    end if;
  elsif new.decided_at is distinct from old.decided_at then
    new.decided_at := old.decided_at;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- touches
-- ---------------------------------------------------------------------------------------------------------------

-- The one email address in a recipient line, lower-cased: 'Priya <PRIYA@example.com>' -> 'priya@example.com'.
-- Null when the line holds no address or more than one. Same pattern as parseRecipient() in lib/mail.ts.
create function recipient_key(p_recipient text) returns text language sql immutable set search_path = '' as $$
  select case when count(distinct lower(m[1])) = 1 and char_length(min(lower(m[1]))) <= 254 then min(lower(m[1])) end
    from regexp_matches(coalesce(p_recipient, ''), '([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)', 'g') as m
$$;

create table touches (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  recipient_key text not null check (char_length(recipient_key) between 3 and 254),
  approval_id bigint not null unique,
  at timestamptz not null default now()
);
create index touches_user_key_idx on touches (user_id, recipient_key, at desc);

-- Closed to everyone but the database itself: an assistant cannot read, add, change or remove a touch, and soft-
-- deleting the approval behind it does not remove it either.
alter table touches enable row level security;
revoke all on touches from anon, authenticated;

create function record_touch() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  k text;
begin
  if new.status in ('sent', 'failed') and old.status is distinct from new.status and new.channel <> 'api' then
    k := public.recipient_key(new.recipient);
    if k is not null then
      insert into public.touches (user_id, recipient_key, approval_id) values (new.user_id, k, new.id)
      on conflict (approval_id) do nothing;
    end if;
  end if;
  return null;
end $$;
create trigger approvals_touch after update of status on approvals for each row execute function record_touch();

-- Drafts already sent before this migration count too.
insert into touches (user_id, recipient_key, approval_id, at)
select user_id, recipient_key(recipient), id, coalesce(send_claimed_at, decided_at, created_at)
  from approvals
 where status in ('sent', 'failed') and channel <> 'api' and recipient_key(recipient) is not null
on conflict (approval_id) do nothing;

-- Why one more email to this recipient is not allowed now, or null. At most 2 touches to one address in 30 days.
create function touch_block(p_user uuid, p_recipient text) returns text language plpgsql stable security definer set search_path = '' as $$
declare
  k text := public.recipient_key(p_recipient);
  n integer;
  oldest timestamptz;
begin
  if k is null then
    return null;
  end if;
  select count(*), min(at) into n, oldest from public.touches
   where user_id = p_user and recipient_key = k and at > now() - interval '30 days';
  if n >= 2 then
    return format('Blocked: %s already got %s emails from you in the last 30 days, and a third is not sent. '
                  'It stays approved; Send now works again after %s', k, n, to_char(oldest + interval '30 days', 'YYYY-MM-DD'));
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- send_claim: counts tries and applies the touch cap
-- ---------------------------------------------------------------------------------------------------------------

-- Take an approved email or API request for running. One sender gets it; see the vault migration. A send refused by
-- the touch cap returns {blocked: why} instead of a claim, and writes the reason on the draft, which stays approved.
create or replace function send_claim(p_user uuid, p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ap public.approvals;
  sec public.secrets;
  today integer;
  why text;
begin
  select * into ap from public.approvals where id = p_id and user_id = p_user and deleted_at is null for update;
  if not found then
    raise exception 'Cannot send draft %: not found', p_id;
  end if;
  if ap.status <> 'approved' then
    raise exception 'Cannot send draft %: it is %, not approved', p_id, ap.status;
  end if;
  if ap.channel = 'email' then
    select * into sec from public.secrets where user_id = p_user and kind = 'smtp' and deleted_at is null;
    if not found then
      raise exception 'Cannot send draft %: no email connection', p_id;
    end if;
  elsif ap.channel = 'api' and ap.action is not null then
    select * into sec from public.secrets
     where user_id = p_user and kind = 'api' and name = ap.action ->> 'key' and deleted_at is null;
    if not found then
      raise exception 'Cannot send draft %: its saved key was removed', p_id;
    end if;
    if sec.meta ->> 'writes' <> 'ask' then
      raise exception 'Cannot send draft %: its saved key is now read only', p_id;
    end if;
  else
    raise exception 'Cannot send draft %: it is not an email', p_id;
  end if;
  if ap.send_after is not null and ap.send_after > now() then
    raise exception 'Cannot send draft %: it is scheduled for later', p_id;
  end if;
  if ap.send_claimed_at is not null and ap.send_claimed_at > now() - interval '5 minutes' then
    raise exception 'Cannot send draft %: it is already being sent', p_id;
  end if;
  if ap.channel = 'email' then
    -- one lock per person and recipient, so two senders cannot both pass the cap for the same address
    perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || coalesce(public.recipient_key(ap.recipient), ''), 11));
    why := public.touch_block(p_user, ap.recipient);
    if why is not null then
      update public.approvals set result = left(why, 1000) where id = p_id;
      return jsonb_build_object('user_id', p_user, 'blocked', why);
    end if;
  end if;
  select count(*) into today from public.approvals
   where user_id = p_user and channel = ap.channel and status in ('sent', 'failed') and send_claimed_at > now() - interval '24 hours';
  if ap.channel = 'email' and today >= 50 then
    raise exception 'Cannot send draft %: the limit of 50 emails a day is reached', p_id;
  end if;
  if ap.channel = 'api' and today >= 200 then
    raise exception 'Cannot send draft %: the limit of 200 approved requests a day is reached', p_id;
  end if;
  update public.approvals set send_claimed_at = now(), send_tries = least(send_tries + 1, 1000) where id = p_id returning * into ap;
  return jsonb_build_object(
    'user_id', p_user,
    'approval', to_jsonb(ap) - 'user_id' - 'deleted_at',
    'meta', sec.meta,
    'ciphertext', sec.ciphertext);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the timer (server secret key only)
-- ---------------------------------------------------------------------------------------------------------------

-- Approved emails whose time has come, oldest first: [{user_id, id, chat_id}]. chat_id is the person's linked
-- Telegram chat (or null), so the timer can tell them what happened. Left out: drafts the touch cap blocked (the
-- person decides with Send now), drafts tried 3 times, drafts being sent, and people without a mail connection.
create function cron_due_sends(p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', d.user_id, 'id', d.id, 'chat_id', d.chat_id) order by d.send_after, d.id)
      from (
        select a.user_id, a.id, a.send_after,
               (select l.external_id from public.channel_links l
                 where l.user_id = a.user_id and l.channel = 'telegram' and l.deleted_at is null) as chat_id
          from public.approvals a
         where a.status = 'approved' and a.channel = 'email' and a.deleted_at is null
           and a.send_after is not null and a.send_after <= now()
           and a.send_tries < 3
           and (a.send_claimed_at is null or a.send_claimed_at <= now() - interval '5 minutes')
           and coalesce(a.result, '') not like 'Blocked:%'
           and exists (select 1 from public.secrets s where s.user_id = a.user_id and s.kind = 'smtp' and s.deleted_at is null)
         order by a.send_after, a.id
         limit greatest(1, least(p_limit, 200))) d), '[]'::jsonb);
end $$;

create index approvals_due_idx on approvals (send_after) where status = 'approved' and channel = 'email' and deleted_at is null;

revoke all on function record_touch() from public, anon, authenticated;
revoke all on function touch_block(uuid, text) from public, anon, authenticated, service_role;
revoke all on function cron_due_sends(integer) from public, anon, authenticated;
grant execute on function cron_due_sends(integer) to service_role;
