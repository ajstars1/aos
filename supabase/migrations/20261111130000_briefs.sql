-- Phase B, part 2: a morning brief and an evening line on the person's linked Telegram chat, at their own local time.
--
-- The person picks the hours and switches each message on or off on /app (their own row in profiles). The timer
-- (the cron route, server secret key) works out who is due in their time zone, then calls brief_claim() once per
-- person, message and local day. brief_log makes that at most once: a second run, a retried run or two runs at the
-- same time get nothing back. A send that Telegram refused outright may be tried again, up to 3 times.

alter table profiles
  add column brief_hour smallint not null default 8 check (brief_hour between 0 and 23),
  add column evening_hour smallint not null default 21 check (evening_hour between 0 and 23),
  add column brief_on boolean not null default true,
  add column evening_on boolean not null default true;

create table brief_log (
  user_id uuid not null references auth.users (id),
  kind text not null check (kind in ('morning', 'evening')),
  -- the person's local date the message belongs to
  day date not null,
  state text not null default 'sending' check (state in ('sending', 'sent', 'failed')),
  tries smallint not null default 1 check (tries between 1 and 10),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (user_id, kind, day)
);

-- Nobody but the server functions below reads or writes it.
alter table brief_log enable row level security;
revoke all on brief_log from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- the timer (server secret key only)
-- ---------------------------------------------------------------------------------------------------------------

-- Everyone with a linked chat and at least one message switched on, with their zone and hours. No chat id here:
-- brief_claim() reads it at the moment of sending, so an unlink in between is respected.
create function brief_targets()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', l.user_id,
             'timezone', coalesce(p.timezone, 'Asia/Kolkata'),
             'brief_hour', coalesce(p.brief_hour, 8),
             'evening_hour', coalesce(p.evening_hour, 21),
             'brief_on', coalesce(p.brief_on, true),
             'evening_on', coalesce(p.evening_on, true)) order by l.user_id)
      from public.channel_links l
      left join public.profiles p on p.user_id = l.user_id and p.deleted_at is null
     where l.channel = 'telegram' and l.deleted_at is null
       and (coalesce(p.brief_on, true) or coalesce(p.evening_on, true))), '[]'::jsonb);
end $$;

-- Take one message for sending: the person, which message, their local date, and that date's bounds as instants.
-- Returns what the message needs, for that person only, or null when it was already taken today, the message is
-- switched off, or the chat is no longer linked.
create function brief_claim(p_user uuid, p_kind text, p_day date, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  chat text;
  prof public.profiles;
  claimed integer;
begin
  if p_kind not in ('morning', 'evening') then
    raise exception 'kind must be morning or evening';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '26 hours' then
    raise exception 'the day bounds are not one day';
  end if;
  select external_id into chat from public.channel_links
   where user_id = p_user and channel = 'telegram' and deleted_at is null;
  if chat is null then
    return null;
  end if;
  select * into prof from public.profiles where user_id = p_user and deleted_at is null;
  if (p_kind = 'morning' and not coalesce(prof.brief_on, true)) or (p_kind = 'evening' and not coalesce(prof.evening_on, true)) then
    return null;
  end if;

  insert into public.brief_log as b (user_id, kind, day) values (p_user, p_kind, p_day)
  on conflict (user_id, kind, day) do update set state = 'sending', tries = b.tries + 1, claimed_at = now(), finished_at = null
   where b.state = 'failed' and b.tries < 3;
  get diagnostics claimed = row_count;
  if claimed = 0 then
    return null;
  end if;

  return jsonb_build_object(
    'chat_id', chat,
    'timezone', coalesce(prof.timezone, 'Asia/Kolkata'),
    'tasks', coalesce((
      select jsonb_agg(to_jsonb(t) - 'user_id' - 'deleted_at' order by t.due_at nulls last)
        from (select * from public.tasks
               where user_id = p_user and deleted_at is null and status in ('todo', 'doing', 'waiting_approval')
               order by due_at nulls last limit 300) t), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(to_jsonb(a) - 'user_id' - 'deleted_at' - 'action' order by a.id)
        from (select * from public.approvals
               where user_id = p_user and deleted_at is null and status = 'pending' order by id limit 50) a), '[]'::jsonb),
    'waiting', (select count(*) from public.approvals where user_id = p_user and deleted_at is null and status = 'pending'),
    'goals', coalesce((
      select jsonb_agg(to_jsonb(g) - 'user_id' - 'deleted_at' order by g.due_at nulls last)
        from public.goals g where g.user_id = p_user and g.deleted_at is null and g.status = 'active'), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) - 'user_id' - 'deleted_at' order by e.starts_at)
        from public.events e
       where e.user_id = p_user and e.deleted_at is null and e.starts_at >= p_from and e.starts_at < p_to), '[]'::jsonb),
    'done', coalesce((
      select jsonb_agg(d.title order by d.updated_at)
        from (select title, updated_at from public.tasks
               where user_id = p_user and deleted_at is null and status = 'done' and updated_at >= p_from and updated_at < p_to
               order by updated_at limit 20) d), '[]'::jsonb),
    'done_count', (select count(*) from public.tasks
                    where user_id = p_user and deleted_at is null and status = 'done' and updated_at >= p_from and updated_at < p_to),
    'sent_count', (select count(*) from public.activity
                    where user_id = p_user and at >= p_from and at < p_to and action ~ '^sent( by aos)? \(approval [0-9]+\)$'));
end $$;

-- How a claimed message ended. ok = Telegram took it (or may have); otherwise it was refused and may be tried again.
create function brief_finish(p_user uuid, p_kind text, p_day date, p_ok boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.brief_log set state = case when p_ok then 'sent' else 'failed' end, finished_at = now()
   where user_id = p_user and kind = p_kind and day = p_day and state = 'sending';
end $$;

revoke all on function brief_targets() from public, anon, authenticated;
revoke all on function brief_claim(uuid, text, date, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function brief_finish(uuid, text, date, boolean) from public, anon, authenticated;
grant execute on function brief_targets() to service_role;
grant execute on function brief_claim(uuid, text, date, timestamptz, timestamptz) to service_role;
grant execute on function brief_finish(uuid, text, date, boolean) to service_role;
