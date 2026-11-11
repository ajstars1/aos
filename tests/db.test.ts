// Runs the real migration on an in-process Postgres (PGlite) and attacks it the way a signed-in user or a
// connected AI app could: with a valid token, straight at the database, without our server in between.
import { beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { randomBytes } from 'node:crypto'
import { binding, seal } from '../lib/vault'
import { BRIEF_COLS } from '../lib/store'
import { ACTIVITY_COLS, APPROVAL_COLS, EVENT_COLS, GOAL_COLS, TASK_COLS } from '../lib/types'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const E_NEWLINE = '/x\ny'
const CAROL = '33333333-3333-4333-8333-333333333333' // added later, for a clean send history
const DAVE = '44444444-4444-4444-8444-444444444444' // a profile created by a connected app
const APP = 'a0000000-0000-4000-8000-00000000000a' // an OAuth client id, as in a token issued to Claude or ChatGPT

// The parts of a Supabase project the migration relies on: roles, the auth schema and its two helpers.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  insert into auth.users (id) values ('${ALICE}'), ('${BOB}');
`

let pg: PGlite

type Row = Record<string, unknown>

interface Who {
  sub?: string
  clientId?: string
  role?: 'authenticated' | 'anon' | 'service_role'
}

// Run one statement as a given token would: the API sets the role and the claims, then runs the query.
const as = async (who: Who, sql: string, params: unknown[] = []): Promise<Row[]> => {
  const claims = JSON.stringify({ sub: who.sub, role: who.role ?? 'authenticated', client_id: who.clientId })
  await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims])
  await pg.exec(`set role ${who.role ?? 'authenticated'}`)
  try {
    return (await pg.query<Row>(sql, params)).rows
  } finally {
    await pg.exec('reset role')
    await pg.query(`select set_config('request.jwt.claims', '', false)`)
  }
}

const alice: Who = { sub: ALICE }
const bob: Who = { sub: BOB }
const aliceApp: Who = { sub: ALICE, clientId: APP }

const fails = async (p: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let message = ''
  try {
    await p
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  expect(message).toMatch(pattern)
}

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(SUPABASE_STUB)
  const dir = join(import.meta.dir, '..', 'supabase', 'migrations')
  for (const file of readdirSync(dir).sort()) await pg.exec(readFileSync(join(dir, file), 'utf8'))
})

describe('isolation between users', () => {
  let aliceTask = 0

  test('a user sees only their own rows', async () => {
    const [t] = await as(alice, `insert into tasks (title) values ('Call the accountant') returning id, user_id`)
    aliceTask = Number(t.id)
    expect(t.user_id).toBe(ALICE)
    await as(bob, `insert into tasks (title) values ('Bob task')`)
    expect((await as(alice, 'select title from tasks')).map((r) => r.title)).toEqual(['Call the accountant'])
    expect((await as(bob, 'select title from tasks')).map((r) => r.title)).toEqual(['Bob task'])
  })

  test('a user cannot change, soft-delete or read another user row by id', async () => {
    expect(await as(bob, `update tasks set title = 'hacked' where id = $1 returning id`, [aliceTask])).toEqual([])
    expect(await as(bob, `update tasks set deleted_at = now() where id = $1 returning id`, [aliceTask])).toEqual([])
    expect(await as(bob, 'select id from tasks where id = $1', [aliceTask])).toEqual([])
    expect((await as(alice, 'select title, deleted_at from tasks where id = $1', [aliceTask]))[0]).toEqual({
      title: 'Call the accountant',
      deleted_at: null,
    })
  })

  test('a user cannot write a row as someone else, or hand a row over', async () => {
    await fails(as(bob, `insert into tasks (title, user_id) values ('planted', $1)`, [ALICE]), /row-level security/)
    await fails(as(alice, `update tasks set user_id = $1 where id = $2`, [BOB, aliceTask]), /row-level security/)
  })

  test('a row cannot point at another user task or goal', async () => {
    await fails(
      as(bob, `insert into approvals (channel, draft, task_id) values ('email', 'hi', $1)`, [aliceTask]),
      /foreign key/,
    )
    const [g] = await as(alice, `insert into goals (title, target) values ('Ten orders', 10) returning id`)
    await fails(as(bob, `insert into tasks (title, goal_id) values ('ride along', $1)`, [g.id]), /foreign key/)
    await fails(as(bob, `select * from record_goal_reading($1, 99)`, [g.id]), /not found/)
  })

  test('nobody can hard-delete, and a signed-out caller gets nothing', async () => {
    await fails(as(alice, 'delete from tasks where id = $1', [aliceTask]), /permission denied/)
    await fails(as({ role: 'anon' }, 'select * from tasks'), /permission denied/)
    await fails(as({ role: 'anon' }, `insert into tasks (title) values ('anon task')`), /permission denied/)
  })

  test('functions act only on the caller rows', async () => {
    await fails(as(bob, `select * from complete_task($1, 'done')`, [aliceTask]), /not found/)
    expect((await as(alice, 'select status from tasks where id = $1', [aliceTask]))[0].status).toBe('todo')
  })
})

describe('the approval guard', () => {
  const draft = async (who: Who, text = 'Hello, following up on the quote.'): Promise<number> => {
    const [ap] = await as(who, `select id from request_approval('email', $1, 'client@example.com')`, [text])
    return Number(ap.id)
  }

  test('a connected app can draft but never approve, by function or by direct update', async () => {
    const id = await draft(aliceApp)
    await fails(as(aliceApp, `select * from decide_approval($1, 'approved')`, [id]), /Only the person can approve/)
    await fails(as(aliceApp, `update approvals set status = 'approved' where id = $1`, [id]), /Only the person can approve/)
    await fails(as(aliceApp, `update approvals set status = 'rejected' where id = $1`, [id]), /Only the person can approve/)
    expect((await as(alice, 'select status from approvals where id = $1', [id]))[0].status).toBe('pending')
  })

  test('a draft cannot be born approved', async () => {
    const [ap] = await as(
      aliceApp,
      `insert into approvals (channel, draft, status, decided_at) values ('email', 'sneaky', 'approved', now()) returning status, decided_at`,
    )
    expect(ap).toEqual({ status: 'pending', decided_at: null })
  })

  test('an app cannot mark an unapproved draft as sent', async () => {
    const id = await draft(aliceApp)
    await fails(as(aliceApp, `select * from mark_approval_sent($1, 'sent it')`, [id]), /Only an approved draft/)
    await fails(as(aliceApp, `update approvals set status = 'sent' where id = $1`, [id]), /Only an approved draft/)
  })

  test('the person approves; the approved text is then frozen', async () => {
    const id = await draft(aliceApp, 'Original text')
    const [ap] = await as(alice, `select status, draft, decided_at from decide_approval($1, 'approved', 'Edited by Alice')`, [id])
    expect(ap.status).toBe('approved')
    expect(ap.draft).toBe('Edited by Alice')
    expect(ap.decided_at).not.toBeNull()
    await fails(as(aliceApp, `update approvals set draft = 'swapped after approval' where id = $1`, [id]), /Only a pending draft/)
    await fails(as(aliceApp, `update approvals set recipient = 'other@example.com' where id = $1`, [id]), /Only a pending draft/)
    await fails(as(alice, `select * from decide_approval($1, 'rejected')`, [id]), /already decided/)
    await fails(as(alice, `update approvals set status = 'pending' where id = $1`, [id]), /cannot go back/)
  })

  test('sending an approved draft logs it and closes its task', async () => {
    const [t] = await as(alice, `insert into tasks (title, area) values ('Send the quote', 'sales') returning id`)
    const [ap] = await as(aliceApp, `select id from request_approval('email', 'Quote attached.', 'client@example.com', $1)`, [t.id])
    expect((await as(alice, 'select status from tasks where id = $1', [t.id]))[0].status).toBe('waiting_approval')
    await as(alice, `select * from decide_approval($1, 'approved')`, [ap.id])
    const [sent] = await as(aliceApp, `select status, result from mark_approval_sent($1, 'Sent from Gmail 10:02')`, [ap.id])
    expect(sent).toEqual({ status: 'sent', result: 'Sent from Gmail 10:02' })
    expect((await as(alice, 'select status from tasks where id = $1', [t.id]))[0].status).toBe('done')
    const log = await as(alice, `select area, channel, account, action from activity where task_id = $1`, [t.id])
    expect(log).toEqual([{ area: 'sales', channel: 'email', account: 'client@example.com', action: `sent (approval ${ap.id})` }])
  })

  test('a rejected draft frees its task', async () => {
    const [t] = await as(alice, `insert into tasks (title) values ('Post the update') returning id`)
    const [ap] = await as(aliceApp, `select id from request_approval('linkedin-post', 'Big news', null, $1)`, [t.id])
    await as(alice, `select * from decide_approval($1, 'rejected')`, [ap.id])
    expect((await as(alice, 'select status from tasks where id = $1', [t.id]))[0].status).toBe('todo')
  })

  test('one user cannot decide another user draft', async () => {
    const id = await draft(aliceApp)
    await fails(as(bob, `select * from decide_approval($1, 'approved')`, [id]), /not found/)
  })
})

describe('tasks and goals', () => {
  test('closing a recurring task creates the next one in the same series', async () => {
    const [t] = await as(
      alice,
      `insert into tasks (title, due_at, recur, owner) values ('Check the inbox', '2026-11-10T04:30:00Z', 'daily', 'assistant') returning id`,
    )
    const rows = await as(alice, `select id, status, due_at, recur, parent_id, owner from complete_task($1, 'done', 'nothing new', '2026-11-11T04:30:00Z')`, [t.id])
    expect(rows).toHaveLength(2)
    expect(rows[0].status).toBe('done')
    expect(rows[1]).toMatchObject({ status: 'todo', recur: 'daily', owner: 'assistant' })
    expect(Number(rows[1].parent_id)).toBe(Number(t.id))
    expect(new Date(String(rows[1].due_at)).toISOString()).toBe('2026-11-11T04:30:00.000Z')
    await fails(as(alice, `select * from complete_task($1, 'done')`, [t.id]), /already closed/)
  })

  test('a recurring task needs a due time and a valid pattern', async () => {
    await fails(as(alice, `insert into tasks (title, recur) values ('No date', 'daily')`), /check constraint/)
    await fails(as(alice, `insert into tasks (title, recur, due_at) values ('Bad', 'hourly', now())`), /check constraint/)
  })

  test('a goal reading keeps history and marks the goal met at target', async () => {
    const [g] = await as(alice, `insert into goals (title, target, unit) values ('Five paying clients', 5, 'clients') returning id`)
    expect((await as(alice, `select current, status from record_goal_reading($1, 2, 'two signed')`, [g.id]))[0]).toMatchObject({ status: 'active' })
    expect((await as(alice, `select status from record_goal_reading($1, 5)`, [g.id]))[0].status).toBe('met')
    expect(await as(alice, 'select count(*)::int as n from goal_readings where goal_id = $1', [g.id])).toEqual([{ n: 2 }])
  })

  test('oversized text is refused by the database itself', async () => {
    await fails(as(alice, `insert into tasks (title) values ($1)`, ['x'.repeat(301)]), /check constraint/)
    await fails(as(alice, `insert into approvals (channel, draft) values ('email', $1)`, ['x'.repeat(5001)]), /check constraint/)
  })
})

describe('limits', () => {
  test('a row quota stops one user filling a table', async () => {
    await as(bob, `insert into goals (title, target) select 'Goal ' || n, 1 from generate_series(1, 200) n`)
    await fails(as(bob, `insert into goals (title, target) values ('One too many', 1)`), /Limit reached/)
    // another user is not affected
    await as(alice, `insert into goals (title, target) values ('Still fine', 1)`)
  })

  test('the rate limit counts per user and cannot be read or reset by the user', async () => {
    const hit = async (who: Who): Promise<boolean> => Boolean((await as(who, `select hit_rate('mcp', 3, 3600) as ok`))[0].ok)
    expect([await hit(alice), await hit(alice), await hit(alice)]).toEqual([true, true, true])
    expect(await hit(alice)).toBe(false)
    expect(await hit(bob)).toBe(true)
    await fails(as(alice, 'select * from rate_hits'), /permission denied/)
    await fails(as(alice, 'update rate_hits set hits = 0'), /permission denied/)
    expect(Boolean((await as({ role: 'authenticated' }, `select hit_rate('mcp', 3, 3600) as ok`))[0].ok)).toBe(false)
  })
})

// The data library talks to the database by name. A renamed column or function argument would only show up in
// production, so check every name the code uses against the real schema.
describe('the phone channel', () => {
  // the bot's webhook, calling with the server's secret key
  const server: Who = { role: 'service_role' }
  const CHAT = '700100'
  let code = ''

  const snapshot = async (chat: string): Promise<Record<string, unknown> | null> =>
    (await as(server, `select channel_snapshot('telegram', $1, now() - interval '1 day', now() + interval '1 day') as s`, [chat]))[0]
      .s as Record<string, unknown> | null

  test('only the person, signed in on the site, can make a link code', async () => {
    await fails(as(aliceApp, `select create_link_code('telegram')`), /assistant cannot/)
    await fails(as({ role: 'anon' }, `select create_link_code('telegram')`), /permission denied/)
    await fails(as(alice, `select create_link_code('sms')`), /Unknown channel/)
    code = String((await as(alice, `select create_link_code('telegram') as c`))[0].c)
    expect(code).toMatch(/^[0-9a-f]{64}$/)
    await fails(as(alice, 'select * from link_codes'), /permission denied/)
  })

  test('users and apps cannot call the bot functions', async () => {
    await fails(as(bob, `select channel_claim('telegram', $1, '999', null)`, [code]), /permission denied/)
    await fails(as(aliceApp, `select channel_decide('telegram', $1, 1, 'approved')`, [CHAT]), /permission denied/)
    await fails(as(alice, `select channel_snapshot('telegram', $1, now(), now())`, [CHAT]), /permission denied/)
    await fails(as(server, `select channel_user('telegram', $1)`, [CHAT]), /permission denied/)
  })

  test('a code links one chat, once', async () => {
    expect(await snapshot(CHAT)).toBeNull()
    expect((await as(server, `select channel_claim('telegram', 'nope', $1, null) as ok`, [CHAT]))[0].ok).toBe(false)
    expect((await as(server, `select channel_claim('telegram', $1, $2, 'Alice') as ok`, [code, CHAT]))[0].ok).toBe(true)
    expect((await as(server, `select channel_claim('telegram', $1, '700999', null) as ok`, [code]))[0].ok).toBe(false)
    expect((await as(alice, `select channel, label from channel_links where deleted_at is null`))).toEqual([{ channel: 'telegram', label: 'Alice' }])
    expect(await as(bob, 'select id from channel_links')).toEqual([])
    expect(await as(bob, 'select external_id from channel_links')).toEqual([])
  })

  test('the linked chat sees only its own person', async () => {
    const snap = await snapshot(CHAT)
    const tasks = snap?.tasks as Array<Record<string, unknown>>
    expect(tasks.length).toBeGreaterThan(0)
    for (const t of tasks) expect(t.user_id).toBeUndefined()
    const bobTitles = (await as(bob, 'select title from tasks')).map((r) => r.title)
    for (const t of tasks) expect(bobTitles).not.toContain(t.title)
  })

  test('yes from the linked chat decides that person\'s draft, and nobody else\'s', async () => {
    const [mine] = await as(aliceApp, `select (request_approval('email', 'Hi from the phone test')).id as id`)
    const [theirs] = await as(bob, `select (request_approval('email', 'Bob draft')).id as id`)
    const decided = (await as(server, `select channel_decide('telegram', $1, $2, 'approved') as a`, [CHAT, mine.id]))[0].a as Record<string, unknown>
    expect(decided.status).toBe('approved')
    expect(decided.user_id).toBeUndefined()
    await fails(as(server, `select channel_decide('telegram', $1, $2, 'approved')`, [CHAT, mine.id]), /already decided/)
    await fails(as(server, `select channel_decide('telegram', $1, $2, 'approved')`, [CHAT, theirs.id]), /not found/)
    await fails(as(server, `select channel_decide('telegram', '123', $1, 'approved')`, [theirs.id]), /not linked/)
    expect((await as(bob, 'select status from approvals where id = $1', [theirs.id]))[0].status).toBe('pending')
  })

  test('the person can unlink but not relink by hand', async () => {
    await fails(as(alice, `update channel_links set label = 'x'`), /permission denied/)
    await as(alice, 'update channel_links set deleted_at = now() where deleted_at is null')
    expect(await snapshot(CHAT)).toBeNull()
    const relinked = await as(alice, 'update channel_links set deleted_at = null returning id')
    expect(relinked).toEqual([])
  })

  test('linking the same chat to a new person moves it', async () => {
    const aliceCode = String((await as(alice, `select create_link_code('telegram') as c`))[0].c)
    const bobCode = String((await as(bob, `select create_link_code('telegram') as c`))[0].c)
    await as(server, `select channel_claim('telegram', $1, $2, null)`, [aliceCode, CHAT])
    await as(server, `select channel_claim('telegram', $1, $2, null)`, [bobCode, CHAT])
    expect(await as(alice, 'select id from channel_links where deleted_at is null')).toEqual([])
    expect((await as(bob, 'select id from channel_links where deleted_at is null')).length).toBe(1)
  })
})

describe('the vault and the sealed send', () => {
  const server: Who = { role: 'service_role' }
  const sealed = seal(randomBytes(32), 'app-password-SECRET', binding(ALICE, 'smtp'))
  const META = JSON.stringify({ provider: 'gmail', username: 'alice@example.com', from_name: 'Alice' })
  const newEmail = async (who: Who, extra = '', to = 'Priya <priya@example.com>'): Promise<number> =>
    Number((await as(who, `select (request_approval('email', 'Approved words.', $1, null, ${extra || 'null'}, 'Quote')).id as id`, [to]))[0].id)
  const claim = (user: string, id: number): Promise<Row[]> => as(server, 'select send_claim($1, $2) as c', [user, id])

  test('an assistant cannot change a draft after asking; the person can', async () => {
    const id = await newEmail(aliceApp)
    await fails(as(aliceApp, `update approvals set draft = 'swapped before the yes' where id = $1`, [id]), /cannot change a draft after asking/)
    await fails(as(aliceApp, `update approvals set recipient = 'thief@example.com' where id = $1`, [id]), /cannot change a draft after asking/)
    await fails(as(aliceApp, `update approvals set subject = 'Other' where id = $1`, [id]), /cannot change a draft after asking/)
    await as(alice, `select decide_approval($1, 'approved', 'Edited by Alice.')`, [id])
    expect((await as(alice, 'select draft, status from approvals where id = $1', [id]))[0]).toEqual({ draft: 'Edited by Alice.', status: 'approved' })
    await fails(as(alice, `update approvals set subject = 'Late change' where id = $1`, [id]), /Only a pending draft/)
  })

  test('a subject cannot carry a line break', async () => {
    await fails(as(alice, `insert into approvals (channel, draft, subject) values ('email', 'x', E'Hi\nBcc: x@evil.test')`), /check constraint/)
  })

  test('only the person can save or remove a login, and nobody can read it back', async () => {
    await fails(as(aliceApp, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, sealed]), /assistant cannot/)
    await fails(as({ role: 'anon' }, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, sealed]), /permission denied/)
    await fails(as(alice, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, 'plain text password']), /check constraint/)
    await fails(as(alice, 'select put_secret($1, $2::jsonb, $3)', ['ftp', META, sealed]), /check constraint/)
    await as(alice, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, sealed])
    await as(alice, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, sealed]) // replacing keeps one row
    expect((await as(alice, `select kind, meta ->> 'username' as username from secrets where deleted_at is null`))).toEqual([{ kind: 'smtp', username: 'alice@example.com' }])
    await fails(as(alice, 'select ciphertext from secrets'), /permission denied/)
    await fails(as(alice, 'select * from secrets'), /permission denied/)
    await fails(as(alice, `update secrets set meta = '{}'`), /permission denied/)
    await fails(as(alice, `insert into secrets (user_id, kind, ciphertext) values ('${ALICE}', 'smtp', '')`), /permission denied/)
    expect(await as(aliceApp, 'select id from secrets')).toEqual([])
    expect(await as(bob, 'select id from secrets')).toEqual([])
    await fails(as(aliceApp, `select remove_secret('smtp')`), /assistant cannot/)
  })

  test('an assistant learns only that email is connected, with a hint of the address', async () => {
    expect((await as(aliceApp, 'select connection_status() as s'))[0].s).toEqual({ email: { connected: true, address_hint: 'a***@example.com' }, api_keys: [] })
    expect((await as(bob, 'select connection_status() as s'))[0].s).toEqual({ email: { connected: false }, api_keys: [] })
  })

  test('users and apps cannot call the send functions or claim a send by hand', async () => {
    const id = await newEmail(aliceApp)
    await as(alice, `select decide_approval($1, 'approved')`, [id])
    await fails(as(alice, 'select send_claim($1, $2)', [ALICE, id]), /permission denied/)
    await fails(as(aliceApp, 'select send_claim($1, $2)', [ALICE, id]), /permission denied/)
    await fails(as(aliceApp, `select send_finish($1, $2, 'sent', 'x')`, [ALICE, id]), /permission denied/)
    await fails(as(alice, `select channel_send_claim('telegram', '700100', $1)`, [id]), /permission denied/)
    await fails(as(aliceApp, 'update approvals set send_claimed_at = now() where id = $1', [id]), /Only the aos server/)
    await fails(as(alice, 'update approvals set send_claimed_at = now() where id = $1', [id]), /Only the aos server/)
  })

  test('only an approved, due email of that user can be claimed, and only once', async () => {
    const pending = await newEmail(aliceApp)
    await fails(claim(ALICE, pending), /it is pending, not approved/)
    const [post] = await as(aliceApp, `select (request_approval('linkedin-post', 'A post')).id as id`)
    await as(alice, `select decide_approval($1, 'approved')`, [post.id])
    await fails(claim(ALICE, Number(post.id)), /it is not an email/)
    const later = await newEmail(aliceApp, `now() + interval '1 day'`)
    await as(alice, `select decide_approval($1, 'approved')`, [later])
    await fails(claim(ALICE, later), /scheduled for later/)

    const id = await newEmail(aliceApp)
    await as(alice, `select decide_approval($1, 'approved')`, [id])
    await fails(claim(BOB, id), /not found/)
    const got = (await claim(ALICE, id))[0].c as { user_id: string; approval: Row; meta: Row; ciphertext: string }
    expect(got.user_id).toBe(ALICE)
    expect(got.ciphertext).toBe(sealed)
    expect(got.meta.username).toBe('alice@example.com')
    expect([got.approval.draft, got.approval.subject, got.approval.recipient]).toEqual(['Approved words.', 'Quote', 'Priya <priya@example.com>'])
    await fails(claim(ALICE, id), /already being sent/)

    // a send that certainly did not go out is released and can be claimed again
    await as(server, `select send_finish($1, $2, 'retry', 'Not sent: login refused.')`, [ALICE, id])
    expect((await as(alice, 'select status, result from approvals where id = $1', [id]))[0]).toEqual({ status: 'approved', result: 'Not sent: login refused.' })
    await claim(ALICE, id)
    await as(server, `select send_finish($1, $2, 'sent', 'Sent by aos')`, [ALICE, id])
    expect((await as(alice, 'select status from approvals where id = $1', [id]))[0].status).toBe('sent')
    await fails(claim(ALICE, id), /it is sent, not approved/)
    await fails(as(server, `select send_finish($1, $2, 'sent', 'again')`, [ALICE, id]), /is not being sent/)
    const log = await as(alice, `select channel, account, action from activity where action = 'sent by aos (approval ${id})'`)
    expect(log).toEqual([{ channel: 'email', account: 'Priya <priya@example.com>', action: `sent by aos (approval ${id})` }])
    expect(await as(bob, `select id from activity where action like 'sent by aos%'`)).toEqual([])
  })

  test('a sent email closes its task; a stale claim frees itself', async () => {
    const [t] = await as(alice, `insert into tasks (title) values ('Send the quote') returning id`)
    const [ap] = await as(aliceApp, `select (request_approval('email', 'Body', 'priya@example.com', $1, null, 'Quote')).id as id`, [t.id])
    await as(alice, `select decide_approval($1, 'approved')`, [ap.id])
    await claim(ALICE, Number(ap.id))
    await pg.query(`update approvals set send_claimed_at = now() - interval '6 minutes' where id = $1`, [ap.id])
    await claim(ALICE, Number(ap.id))
    await as(server, `select send_finish($1, $2, 'sent', 'ok')`, [ALICE, ap.id])
    expect((await as(alice, 'select status from tasks where id = $1', [t.id]))[0].status).toBe('done')
  })

  test('a yes from the linked chat can claim only that person\'s email', async () => {
    const code = String((await as(alice, `select create_link_code('telegram') as c`))[0].c)
    await as(server, `select channel_claim('telegram', $1, '800200', null)`, [code])
    const id = await newEmail(aliceApp, '', 'ravi@example.com')
    await as(server, `select channel_decide('telegram', '800200', $1, 'approved')`, [id])
    await fails(as(server, `select channel_send_claim('telegram', '999', $1)`, [id]), /not linked/)
    const got = (await as(server, `select channel_send_claim('telegram', '800200', $1) as c`, [id]))[0].c as { user_id: string }
    expect(got.user_id).toBe(ALICE)
    await as(server, `select send_finish($1, $2, 'failed', 'May not have been sent')`, [ALICE, id])
    expect((await as(alice, 'select status from approvals where id = $1', [id]))[0].status).toBe('failed')
  })

  test('no more than 50 emails a day', async () => {
    await pg.query(
      `insert into approvals (user_id, channel, draft, recipient, subject) select $1, 'email', 'x', 'p@example.com', 's' from generate_series(1, 50)`, [ALICE],
    )
    await pg.query(`update approvals set status = 'approved' where user_id = $1 and draft = 'x'`, [ALICE])
    await pg.query(`update approvals set send_claimed_at = now(), status = 'sent' where user_id = $1 and draft = 'x'`, [ALICE])
    const id = await newEmail(aliceApp, '', 'meera@example.com')
    await as(alice, `select decide_approval($1, 'approved')`, [id])
    await fails(claim(ALICE, id), /limit of 50 emails a day/)
  })

  test('removing a login erases it; sends then find no connection', async () => {
    expect((await as(alice, `select remove_secret('smtp') as ok`))[0].ok).toBe(true)
    const rows = (await pg.query<{ ciphertext: string; gone: boolean }>(`select ciphertext, deleted_at is not null as gone from secrets where user_id = $1`, [ALICE])).rows
    expect(rows).toEqual([{ ciphertext: '', gone: true }])
    expect((await as(aliceApp, 'select connection_status() as s'))[0].s).toEqual({ email: { connected: false }, api_keys: [] })
    await pg.query(`update approvals set send_claimed_at = null where user_id = $1 and draft = 'x'`, [ALICE])
    const id = await newEmail(aliceApp)
    await as(alice, `select decide_approval($1, 'approved')`, [id])
    await fails(claim(ALICE, id), /no email connection/)
  })
})

describe('saved API keys', () => {
  const server: Who = { role: 'service_role' }
  const sealedKey = (user: string, name: string): string => seal(randomBytes(32), 'sk_live_SECRET', binding(user, `api:${name}`))
  const meta = (over: Record<string, unknown> = {}): string => JSON.stringify({ host: 'api.example.com', scheme: 'bearer', writes: 'ask', ...over })
  const put = (who: Who, name: string, m: string): Promise<Row[]> => as(who, 'select put_secret($1, $2::jsonb, $3, $4)', ['api', m, sealedKey(ALICE, name), name])

  test('only the person saves a key, and only for a public host', async () => {
    await fails(put(aliceApp, 'pay', meta()), /assistant cannot/)
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', 'intranet', 'db.internal', 'printer.local', 'evil.com/x', 'API.EXAMPLE.COM', 'a@b.com']) {
      await fails(put(alice, 'pay', meta({ host })), /public address/)
    }
    await fails(put(alice, 'pay', meta({ scheme: 'query' })), /Unknown way/)
    await fails(put(alice, 'pay', meta({ scheme: 'header', header: 'X Bad' })), /header name/)
    await fails(put(alice, 'pay', meta({ writes: 'always' })), /never or ask/)
    await fails(put(alice, 'Bad Name', meta()), /check constraint/)
    await put(alice, 'pay', meta())
    await put(alice, 'shop', meta({ host: 'shop.example.org', writes: 'never' }))
    await put(alice, 'pay', meta()) // saving again replaces
    expect(await as(alice, `select name, meta ->> 'host' as host from secrets where kind = 'api' and deleted_at is null order by name`)).toEqual([
      { name: 'pay', host: 'api.example.com' },
      { name: 'shop', host: 'shop.example.org' },
    ])
    await fails(as(alice, `select ciphertext from secrets where kind = 'api'`), /permission denied/)
    expect(await as(aliceApp, 'select name from secrets')).toEqual([])
    expect(await as(bob, 'select name from secrets')).toEqual([])
  })

  test('an assistant sees names and hosts, never a key', async () => {
    const s = (await as(aliceApp, 'select connection_status() as s'))[0].s as { api_keys: Row[] }
    expect(s.api_keys).toEqual([
      { name: 'pay', host: 'api.example.com', changes: 'after the person says yes' },
      { name: 'shop', host: 'shop.example.org', changes: 'not allowed' },
    ])
    expect(JSON.stringify(s)).not.toContain('v1.')
  })

  test('only the server reads a key, for that person, at most 30 times a minute', async () => {
    await fails(as(alice, `select api_key_read($1, 'pay')`, [ALICE]), /permission denied/)
    await fails(as(aliceApp, `select api_key_read($1, 'pay')`, [ALICE]), /permission denied/)
    const got = (await as(server, `select api_key_read($1, 'pay') as k`, [ALICE]))[0].k as { meta: Row; ciphertext: string }
    expect(got.meta.host).toBe('api.example.com')
    expect(got.ciphertext).toMatch(/^v1\./)
    await fails(as(server, `select api_key_read($1, 'pay')`, [BOB]), /No API key named "pay"/)
    await fails(as(server, `select api_key_read($1, 'nope')`, [ALICE]), /No API key named "nope"/)
    await pg.query(`update rate_hits set hits = 30 where user_id = $1 and bucket = 'api'`, [ALICE])
    await fails(as(server, `select api_key_read($1, 'pay')`, [ALICE]), /Too many API requests/)
    await pg.query(`delete from rate_hits where bucket = 'api'`)
  })

  test('a request that changes something is written by the database, exactly as it will run', async () => {
    const [ap] = await as(aliceApp, `select * from request_action('pay', 'POST', '/v1/refunds?x=1', '{"payment":"pay_1"}')`)
    expect([ap.status, ap.channel, ap.recipient]).toEqual(['pending', 'api', 'POST api.example.com/v1/refunds?x=1'])
    expect(ap.draft).toBe('POST https://api.example.com/v1/refunds?x=1\n(with your saved key "pay")\n\n{"payment":"pay_1"}')
    expect(ap.action).toEqual({ key: 'pay', method: 'POST', path: '/v1/refunds?x=1', body: '{"payment":"pay_1"}', content_type: 'application/json' })
    await fails(as(aliceApp, `select request_action('shop', 'POST', '/x')`), /read only/)
    await fails(as(aliceApp, `select request_action('nope', 'POST', '/x')`), /No API key named/)
    await fails(as(bob, `select request_action('pay', 'POST', '/x')`), /No API key named/)
    await fails(as(aliceApp, `select request_action('pay', 'GET', '/x')`), /method must be/)
    for (const path of ['x', '/a b', E_NEWLINE, '//' + 'x'.repeat(1000)]) await fails(as(aliceApp, `select request_action('pay', 'POST', $1)`, [path]), /path must start/)
    await fails(as(aliceApp, `select request_action('pay', 'POST', '/x', $1)`, ['y'.repeat(4001)]), /too long/)
    await fails(as(aliceApp, `select request_action('pay', 'POST', '/x', 'a', 'text/html')`), /content_type/)
  })

  test('nobody can hand-write, edit or fake-finish an API request', async () => {
    await fails(as(aliceApp, `insert into approvals (channel, draft) values ('api', 'GET https://api.example.com/balance')`), /must be asked with api_request/)
    await fails(as(alice, `insert into approvals (channel, draft, action) values ('email', 'hi', '{"key":"pay","method":"POST","path":"/transfer"}')`), /must be asked with api_request/)
    const [ap] = await as(aliceApp, `select * from request_action('pay', 'DELETE', '/v1/customers/7')`)
    await fails(as(aliceApp, `update approvals set action = jsonb_set(action, '{path}', '"/v1/customers/8"') where id = $1`, [ap.id]), /cannot change a draft after asking/)
    await fails(as(aliceApp, `update approvals set draft = 'GET something harmless' where id = $1`, [ap.id]), /cannot change a draft after asking/)
    await fails(as(alice, `update approvals set draft = 'looks different' where id = $1`, [ap.id]), /cannot be edited/)
    await fails(as(alice, `select decide_approval($1, 'approved', 'edited text')`, [ap.id]), /cannot be edited/)
    const [mail] = await as(aliceApp, `select (request_approval('email', 'Hi')).id as id`)
    await fails(as(alice, `update approvals set action = '{"key":"pay","method":"POST","path":"/x"}', channel = 'api' where id = $1`, [mail.id]), /cannot be edited/)
    await as(alice, `select decide_approval($1, 'approved')`, [ap.id])
    await fails(as(aliceApp, `select mark_approval_sent($1, 'I did it myself')`, [ap.id]), /Only aos can run/)
    await fails(as(alice, `update approvals set status = 'sent' where id = $1`, [ap.id]), /Only aos can run/)
  })

  test('the server claims an approved request once, with the right key', async () => {
    const [ap] = await as(aliceApp, `select * from request_action('pay', 'POST', '/v1/refunds', '{"a":1}')`)
    await fails(as(server, 'select send_claim($1, $2)', [ALICE, ap.id]), /it is pending, not approved/)
    await as(alice, `select decide_approval($1, 'approved')`, [ap.id])
    await fails(as(server, 'select send_claim($1, $2)', [BOB, ap.id]), /not found/)
    const got = (await as(server, 'select send_claim($1, $2) as c', [ALICE, ap.id]))[0].c as { approval: { action: Row }; meta: Row; ciphertext: string }
    expect([got.meta.host, got.approval.action.path]).toEqual(['api.example.com', '/v1/refunds'])
    await fails(as(server, 'select send_claim($1, $2)', [ALICE, ap.id]), /already being sent/)
    await as(server, `select send_finish($1, $2, 'sent', 'HTTP 201')`, [ALICE, ap.id])
    expect((await as(alice, 'select status, result from approvals where id = $1', [ap.id]))[0]).toEqual({ status: 'sent', result: 'HTTP 201' })

    // a key made read only, or removed, after the request was asked: nothing runs
    const [later] = await as(aliceApp, `select * from request_action('pay', 'POST', '/v1/refunds')`)
    await as(alice, `select decide_approval($1, 'approved')`, [later.id])
    await put(alice, 'pay', meta({ writes: 'never' }))
    await fails(as(server, 'select send_claim($1, $2)', [ALICE, later.id]), /now read only/)
    await fails(as(aliceApp, `select remove_secret('api', 'pay')`), /assistant cannot/)
    expect((await as(alice, `select remove_secret('api', 'pay') as ok`))[0].ok).toBe(true)
    await fails(as(server, 'select send_claim($1, $2)', [ALICE, later.id]), /saved key was removed/)
    expect((await pg.query<{ ciphertext: string }>(`select ciphertext from secrets where user_id = $1 and name = 'pay'`, [ALICE])).rows.every((r) => r.ciphertext === '')).toBe(true)
  })

  test('at most 20 keys', async () => {
    for (let i = 0; i < 20; i++) await as(bob, 'select put_secret($1, $2::jsonb, $3, $4)', ['api', meta(), sealedKey(BOB, `k${i}`), `k${i}`])
    await fails(as(bob, 'select put_secret($1, $2::jsonb, $3, $4)', ['api', meta(), sealedKey(BOB, 'one-more'), 'one-more']), /at most 20/)
  })
})

describe('stand-ins for contact details', () => {
  const server: Who = { role: 'service_role' }
  const mask = async (user: string, emails: string[], phones: string[], source: string): Promise<{ level: string; email: Record<string, number>; phone: Record<string, number> }> =>
    (await as(server, 'select handles_mask($1, $2::text[], $3::text[], $4) as m', [user, emails, phones, source]))[0].m as { level: string; email: Record<string, number>; phone: Record<string, number> }

  test('values from a service get numbers that stay the same', async () => {
    const first = await mask(ALICE, ['b@example.com', 'a@example.com', 'a@example.com'], ['+919876543210'], 'api')
    expect(first).toEqual({ level: 'api', email: { 'a@example.com': 1, 'b@example.com': 2 }, phone: { '+919876543210': 1 } })
    const again = await mask(ALICE, ['c@example.com', 'a@example.com'], [], 'api')
    expect(again.email).toEqual({ 'a@example.com': 1, 'c@example.com': 3 })
  })

  test('the person\'s own data only reuses numbers, unless they chose to hide everything', async () => {
    expect((await mask(ALICE, ['a@example.com', 'new@example.com'], ['9000000001'], 'own'))).toEqual({ level: 'api', email: { 'a@example.com': 1 }, phone: {} })
    await as(alice, `insert into profiles (mask_level) values ('all') on conflict (user_id) do update set mask_level = 'all'`)
    expect((await mask(ALICE, ['new@example.com'], ['9000000001'], 'own'))).toEqual({ level: 'all', email: { 'new@example.com': 4 }, phone: { '9000000001': 2 } })
    await as(alice, `update profiles set mask_level = 'off'`)
    expect(await mask(ALICE, ['a@example.com'], [], 'api')).toEqual({ level: 'off', email: {}, phone: {} })
    await as(alice, `update profiles set mask_level = 'api'`)
  })

  test('numbers are per person', async () => {
    expect((await mask(BOB, ['a@example.com'], [], 'api')).email).toEqual({ 'a@example.com': 1 })
    const back = (await as(server, 'select handles_resolve($1, $2::int[], $3::int[]) as r', [BOB, [1, 2, 3], [1]]))[0].r
    expect(back).toEqual({ email: { '1': 'a@example.com' }, phone: {} })
  })

  test('only the server turns a stand-in back into a value; an app cannot even read the table', async () => {
    const back = (await as(server, 'select handles_resolve($1, $2::int[], $3::int[]) as r', [ALICE, [1, 3, 99], [1]]))[0].r
    expect(back).toEqual({ email: { '1': 'a@example.com', '3': 'c@example.com' }, phone: { '1': '+919876543210' } })
    await fails(as(aliceApp, 'select handles_resolve($1, $2::int[], $3::int[])', [ALICE, [1], []]), /permission denied/)
    await fails(as(alice, 'select handles_resolve($1, $2::int[], $3::int[])', [ALICE, [1], []]), /permission denied/)
    await fails(as(aliceApp, 'select handles_mask($1, $2::text[], $3::text[], $4)', [ALICE, ['a@example.com'], [], 'api']), /permission denied/)
    expect(await as(aliceApp, 'select value from handles')).toEqual([])
    expect(await as(bob, `select value from handles where value = 'c@example.com'`)).toEqual([])
    // the person, on the site, can look one up
    expect(await as(alice, `select value from handles where kind = 'email' and n = 3`)).toEqual([{ value: 'c@example.com' }])
    await fails(as(alice, `update handles set value = 'x@example.com'`), /permission denied/)
    await fails(as(alice, `insert into handles (user_id, kind, n, value) values ('${ALICE}', 'email', 50, 'x@example.com')`), /permission denied/)
  })

  test('an assistant cannot switch masking off', async () => {
    await fails(as(aliceApp, `update profiles set mask_level = 'off'`), /Only the person can change privacy/)
    await as(aliceApp, `update profiles set timezone = 'Europe/London'`)
    expect((await as(alice, 'select mask_level, timezone from profiles'))[0]).toEqual({ mask_level: 'api', timezone: 'Europe/London' })
    // a profile first created by an app starts with masking on, whatever it asks for
    await pg.query('update profiles set deleted_at = null where user_id = $1', [BOB])
    await pg.query('delete from profiles where user_id = $1', [BOB])
    await as({ sub: BOB, clientId: APP }, `insert into profiles (mask_level) values ('off')`)
    expect((await as(bob, 'select mask_level from profiles'))[0].mask_level).toBe('api')
  })
})

describe('scheduled sends and the touch cap', () => {
  const server: Who = { role: 'service_role' }
  const carol: Who = { sub: CAROL }
  const carolApp: Who = { sub: CAROL, clientId: APP }
  const META = JSON.stringify({ provider: 'gmail', username: 'carol@example.com' })
  const PAST = '2026-01-01T09:00:00Z'
  const email = async (who: Who, to: string, sendAfter: string | null = null): Promise<number> =>
    Number((await as(who, `select (request_approval('email', 'Hi there.', $1, null, $2::timestamptz, 'Hello')).id as id`, [to, sendAfter]))[0].id)
  const approve = (who: Who, id: number): Promise<Row[]> => as(who, `select decide_approval($1, 'approved')`, [id])
  const claim = async (user: string, id: number): Promise<Row> => (await as(server, 'select send_claim($1, $2) as c', [user, id]))[0].c as Row
  const finish = (user: string, id: number, outcome: string): Promise<Row[]> => as(server, 'select send_finish($1, $2, $3, $4)', [user, id, outcome, 'x'])
  const row = async (id: number): Promise<Row> =>
    (await pg.query<Row>('select status, result, send_claimed_at, send_tries from approvals where id = $1', [id])).rows[0]

  test('setup: a third person with a mailbox, and Bob with one', async () => {
    await pg.query('insert into auth.users (id) values ($1)', [CAROL])
    await as(carol, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, seal(randomBytes(32), 'pw', binding(CAROL, 'smtp'))])
    await as(bob, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, seal(randomBytes(32), 'pw', binding(BOB, 'smtp'))])
  })

  test('one address per recipient line, whatever the case or display name', async () => {
    const key = async (v: string | null): Promise<unknown> => (await pg.query<Row>('select recipient_key($1) as k', [v])).rows[0].k
    expect(await key('Priya <PRIYA@Example.com>')).toBe('priya@example.com')
    expect(await key('priya@example.com, PRIYA@example.com')).toBe('priya@example.com')
    expect(await key('a@example.com, b@example.com')).toBeNull()
    expect(await key('Priya on LinkedIn')).toBeNull()
    expect(await key(null)).toBeNull()
  })

  let third = 0
  test('a third email to one address within 30 days is blocked and stays approved, with the reason', async () => {
    const first = await email(carolApp, 'Dev <dev@example.com>')
    await approve(carol, first)
    await claim(CAROL, first)
    await finish(CAROL, first, 'sent')
    // an email the assistant sent itself and marked sent counts too, and the address is matched in any case
    const second = await email(carolApp, 'DEV@Example.com')
    await approve(carol, second)
    await as(carolApp, `select mark_approval_sent($1, 'sent from Gmail')`, [second])

    third = await email(carolApp, 'dev@example.com')
    await approve(carol, third)
    const got = await claim(CAROL, third)
    expect(String(got.blocked)).toMatch(/^Blocked: dev@example\.com already got 2 emails from you in the last 30 days/)
    expect(got.ciphertext).toBeUndefined()
    expect(got.approval).toBeUndefined()
    const after = await row(third)
    expect(after.status).toBe('approved')
    expect(String(after.result)).toMatch(/^Blocked: dev@example\.com/)
    expect([after.send_claimed_at, after.send_tries]).toEqual([null, 0])

    // another address is not affected
    const other = await email(carolApp, 'eve@example.com')
    await approve(carol, other)
    expect((await claim(CAROL, other)).ciphertext).toMatch(/^v1\./)
    await finish(CAROL, other, 'retry')
  })

  test('the cap is per person: Carol\'s emails do not count for Bob', async () => {
    const id = await email({ sub: BOB, clientId: APP }, 'dev@example.com')
    await approve(bob, id)
    expect((await claim(BOB, id)).ciphertext).toMatch(/^v1\./)
    await finish(BOB, id, 'sent')
  })

  test('the person sets the cap (0 = none); an assistant can neither change it nor create it lifted', async () => {
    const have = await pg.query<Row>('select 1 from profiles where user_id = $1', [CAROL])
    if (!have.rows.length) await as(carol, 'insert into profiles default values')
    await fails(as(carolApp, 'update profiles set touch_cap = 0'), /Only the person can change the email cap/)
    await fails(as(carolApp, 'update profiles set touch_cap = 20'), /Only the person can change the email cap/)

    await pg.query(`insert into touches (user_id, recipient_key, approval_id) values ($1, 'cap@example.com', -10), ($1, 'cap@example.com', -11)`, [CAROL])
    const id = await email(carolApp, 'cap@example.com')
    await approve(carol, id)
    expect(String((await claim(CAROL, id)).blocked)).toMatch(/your cap is 2/)
    await as(carol, 'update profiles set touch_cap = 3')
    expect((await claim(CAROL, id)).ciphertext).toMatch(/^v1\./)
    await finish(CAROL, id, 'sent')
    const fourth = await email(carolApp, 'cap@example.com')
    await approve(carol, fourth)
    expect(String((await claim(CAROL, fourth)).blocked)).toMatch(/already got 3 emails .*your cap is 3/)
    await as(carol, 'update profiles set touch_cap = 0')
    expect((await claim(CAROL, fourth)).ciphertext).toMatch(/^v1\./)
    await finish(CAROL, fourth, 'retry')
    await fails(as(carol, 'update profiles set touch_cap = 21'), /check constraint/)
    await as(carol, 'update profiles set touch_cap = 2')
    if (!have.rows.length) await pg.query('delete from profiles where user_id = $1', [CAROL]) // later tests create it

    // a profile an app creates starts at the default, whatever it asks for
    await pg.query('insert into auth.users (id) values ($1)', [DAVE])
    await as({ sub: DAVE, clientId: APP }, 'insert into profiles (touch_cap) values (0)')
    expect((await pg.query<Row>('select touch_cap from profiles where user_id = $1', [DAVE])).rows[0].touch_cap).toBe(2)
  })

  test('nobody can read, add, change or remove a touch, or change the try count', async () => {
    for (const who of [carol, carolApp, bob]) {
      await fails(as(who, 'select * from touches'), /permission denied/)
      await fails(as(who, `insert into touches (user_id, recipient_key, approval_id) values ('${CAROL}', 'x@example.com', 1)`), /permission denied/)
      await fails(as(who, 'delete from touches'), /permission denied/)
      await fails(as(who, `update touches set at = now() - interval '1 year'`), /permission denied/)
    }
    await fails(as(carolApp, 'select touch_block($1, $2)', [CAROL, 'dev@example.com']), /permission denied/)
    await fails(as(server, 'select touch_block($1, $2)', [CAROL, 'dev@example.com']), /permission denied/)
    await fails(as(carolApp, 'update approvals set send_tries = 5 where id = $1', [third]), /Only the aos server/)
    await fails(as(carol, 'update approvals set send_tries = 5 where id = $1', [third]), /Only the aos server/)
  })

  test('soft-deleting the earlier drafts does not lift the cap; 30 days do', async () => {
    const sent = (await as(carol, `select id from approvals where status = 'sent' and recipient ilike '%dev@example.com%'`)).map((r) => Number(r.id))
    expect(sent.length).toBe(2)
    await as(carolApp, 'update approvals set deleted_at = now() where id = any($1::bigint[])', [sent])
    expect((await claim(CAROL, third)).blocked).toBeDefined()
    await pg.query(`update touches set at = now() - interval '31 days' where user_id = $1`, [CAROL])
    expect((await claim(CAROL, third)).ciphertext).toMatch(/^v1\./)
    await finish(CAROL, third, 'sent')
    expect((await row(third)).status).toBe('sent')
  })

  test('two touches recorded before this rule count from the day they happened', async () => {
    await pg.query(
      `insert into touches (user_id, recipient_key, approval_id, at) values ($1, 'old@example.com', -1, now() - interval '2 days'), ($1, 'old@example.com', -2, now() - interval '40 days')`,
      [CAROL],
    )
    const id = await email(carolApp, 'old@example.com')
    await approve(carol, id)
    expect((await claim(CAROL, id)).ciphertext).toMatch(/^v1\./) // only one is within 30 days
    await finish(CAROL, id, 'retry')
  })

  test('the timer finds approved emails that are due, for people with a mailbox, and nothing else', async () => {
    const due = await email(carolApp, 'f1@example.com', PAST)
    await approve(carol, due)
    const later = await email(carolApp, 'f2@example.com', '2099-01-01T00:00:00Z')
    await approve(carol, later)
    const pending = await email(carolApp, 'f3@example.com', PAST)
    const now = await email(carolApp, 'f4@example.com')
    await approve(carol, now)
    await pg.query(`insert into touches (user_id, recipient_key, approval_id) values ($1, 'blk@example.com', -3), ($1, 'blk@example.com', -4)`, [CAROL])
    const blocked = await email(carolApp, 'blk@example.com', PAST)
    await approve(carol, blocked)
    expect((await claim(CAROL, blocked)).blocked).toBeDefined()
    const bobDue = await email({ sub: BOB, clientId: APP }, 'f5@example.com', PAST)
    await approve(bob, bobDue)
    const aliceDue = await email(aliceApp, 'f6@example.com', PAST) // Alice removed her mailbox earlier
    await approve(alice, aliceDue)

    const list = async (): Promise<Array<{ user_id: string; id: number; chat_id: string | null }>> =>
      (await as(server, 'select cron_due_sends(50) as d'))[0].d as Array<{ user_id: string; id: number; chat_id: string | null }>
    const ids = (await list()).map((d) => Number(d.id))
    expect(ids).toContain(due)
    expect(ids).toContain(bobDue)
    for (const id of [later, pending, now, blocked, aliceDue]) expect(ids).not.toContain(id)
    const bobRow = (await list()).find((d) => Number(d.id) === bobDue)
    expect(bobRow).toEqual({ user_id: BOB, id: bobDue, chat_id: '700100' })
    expect((await list()).find((d) => Number(d.id) === due)?.chat_id).toBeNull()

    // being sent right now: left out; given up after 3 tries
    await claim(CAROL, due)
    expect((await list()).map((d) => Number(d.id))).not.toContain(due)
    await finish(CAROL, due, 'retry')
    await claim(CAROL, due)
    await finish(CAROL, due, 'retry')
    await claim(CAROL, due)
    await finish(CAROL, due, 'retry')
    expect((await row(due)).send_tries).toBe(3)
    expect((await list()).map((d) => Number(d.id))).not.toContain(due)
    // the person can still send it by hand
    expect((await claim(CAROL, due)).ciphertext).toMatch(/^v1\./)
    await finish(CAROL, due, 'sent')
  })

  test('users and apps cannot ask the timer\'s list', async () => {
    await fails(as(carol, 'select cron_due_sends(10)'), /permission denied/)
    await fails(as(carolApp, 'select cron_due_sends(10)'), /permission denied/)
    await fails(as({ role: 'anon' }, 'select cron_due_sends(10)'), /permission denied/)
  })
})

describe('morning brief and evening line', () => {
  const server: Who = { role: 'service_role' }
  const carol: Who = { sub: CAROL }
  const carolApp: Who = { sub: CAROL, clientId: APP }
  const DAY = '2026-11-11'
  const from = (): string => new Date(Date.now() - 12 * 3600_000).toISOString()
  const to = (): string => new Date(Date.now() + 12 * 3600_000).toISOString()
  const claim = async (user: string, kind: string, day = DAY): Promise<Row | null> =>
    (await as(server, 'select brief_claim($1, $2, $3::date, $4::timestamptz, $5::timestamptz) as b', [user, kind, day, from(), to()]))[0].b as Row | null
  const finish = (user: string, kind: string, ok: boolean, day = DAY): Promise<Row[]> =>
    as(server, 'select brief_finish($1, $2, $3::date, $4)', [user, kind, day, ok])
  type Target = { user_id: string; timezone: string; brief_hour: number; evening_hour: number; brief_on: boolean; evening_on: boolean }
  const targets = async (): Promise<Target[]> => (await as(server, 'select brief_targets() as t'))[0].t as Target[]

  test('only linked people are targets, with 08:00 and 21:00 by default', async () => {
    expect((await targets()).find((t) => t.user_id === CAROL)).toBeUndefined()
    expect(await claim(CAROL, 'morning')).toBeNull()
    const code = String((await as(carol, `select create_link_code('telegram') as c`))[0].c)
    await as(server, `select channel_claim('telegram', $1, '900300', null)`, [code])
    expect((await targets()).find((t) => t.user_id === CAROL)).toEqual({
      user_id: CAROL, timezone: 'Asia/Kolkata', brief_hour: 8, evening_hour: 21, brief_on: true, evening_on: true,
    })
  })

  test('the person sets the hours; the database refuses an hour that does not exist', async () => {
    await as(carol, `insert into profiles (timezone, brief_hour, evening_hour) values ('America/New_York', 7, 22)`)
    await fails(as(carol, 'update profiles set brief_hour = 24'), /check constraint/)
    await fails(as(carol, 'update profiles set evening_hour = -1'), /check constraint/)
    expect((await targets()).find((t) => t.user_id === CAROL)).toMatchObject({ timezone: 'America/New_York', brief_hour: 7, evening_hour: 22 })
    // another person cannot change them
    expect(await as(bob, 'update profiles set brief_on = false where user_id = $1 returning user_id', [CAROL])).toEqual([])
    expect((await targets()).find((t) => t.user_id === CAROL)?.brief_on).toBe(true)
  })

  // Two runs at once are serialised by the primary key on brief_log; PGlite runs one query at a time, so here they
  // are simply run one after the other.
  test('one morning brief per person per day, however often the timer runs', async () => {
    const [t] = await as(carol, `insert into tasks (title, due_at) values ('Carol call', now()) returning id`)
    await as(carol, `select complete_task($1, 'done')`, [t.id])
    await as(carol, `insert into tasks (title, due_at) values ('Carol open task', now())`)
    const first = await claim(CAROL, 'morning')
    const second = await claim(CAROL, 'morning')
    const got = [first, second].filter(Boolean) as Row[]
    expect(got.length).toBe(1)
    expect(got[0].chat_id).toBe('900300')
    expect(got[0].timezone).toBe('America/New_York')
    expect(await claim(CAROL, 'morning')).toBeNull()
    await finish(CAROL, 'morning', true)
    expect(await claim(CAROL, 'morning')).toBeNull()
    // the next day is a new one
    expect(await claim(CAROL, 'morning', '2026-11-12')).not.toBeNull()
  })

  test('a message Telegram refused is tried again, at most 3 times', async () => {
    expect(await claim(CAROL, 'evening')).not.toBeNull()
    await finish(CAROL, 'evening', false)
    expect(await claim(CAROL, 'evening')).not.toBeNull()
    await finish(CAROL, 'evening', false)
    expect(await claim(CAROL, 'evening')).not.toBeNull()
    await finish(CAROL, 'evening', false)
    expect(await claim(CAROL, 'evening')).toBeNull()
  })

  test('the brief holds only that person\'s data', async () => {
    const b = (await claim(CAROL, 'evening', '2026-11-13')) as Row
    const json = JSON.stringify(b)
    expect(json).not.toContain('user_id')
    expect(json).not.toContain('Bob task')
    expect((b.tasks as Row[]).map((t) => t.title)).toContain('Carol open task')
    expect(b.done).toEqual(['Carol call'])
    expect(b.done_count).toBe(1)
    const sent = (await pg.query<{ n: number }>(`select count(*)::int as n from activity where user_id = $1 and action like 'sent%'`, [CAROL])).rows[0].n
    expect(sent).toBeGreaterThan(0)
    expect(b.sent_count).toBe(sent)
    expect(b.waiting).toBe((await as(carol, `select count(*)::int as n from approvals where status = 'pending' and deleted_at is null`))[0].n)
    await fails(as(server, 'select brief_claim($1, $2, $3::date, now(), now() + interval \'3 days\')', [CAROL, 'morning', '2026-11-20']), /not one day/)
    await fails(as(server, 'select brief_claim($1, $2, $3::date, now(), now() + interval \'1 day\')', [CAROL, 'noon', '2026-11-20']), /kind must be/)
  })

  test('a message switched off is not sent; both off means not a target', async () => {
    await as(carol, 'update profiles set brief_on = false')
    expect(await claim(CAROL, 'morning', '2026-11-14')).toBeNull()
    expect((await targets()).find((t) => t.user_id === CAROL)).toBeDefined()
    await as(carolApp, 'update profiles set evening_on = false')
    expect((await targets()).find((t) => t.user_id === CAROL)).toBeUndefined()
    expect(await claim(CAROL, 'evening', '2026-11-14')).toBeNull()
  })

  test('users and apps cannot call the brief functions or read the log', async () => {
    for (const who of [carol, carolApp, { role: 'anon' } as Who]) {
      await fails(as(who, 'select brief_targets()'), /permission denied/)
      await fails(as(who, 'select brief_claim($1, $2, $3::date, now(), now() + interval \'1 day\')', [CAROL, 'morning', '2026-11-30']), /permission denied/)
      await fails(as(who, 'select brief_finish($1, $2, $3::date, true)', [CAROL, 'morning', DAY]), /permission denied/)
      await fails(as(who, 'select * from brief_log'), /permission denied/)
    }
  })

  test('an unlinked chat gets nothing', async () => {
    await as(carol, 'update profiles set brief_on = true')
    await as(carol, 'update channel_links set deleted_at = now() where deleted_at is null')
    expect(await claim(CAROL, 'morning', '2026-11-15')).toBeNull()
    expect((await targets()).find((t) => t.user_id === CAROL)).toBeUndefined()
  })
})

describe('code and schema agree', () => {
  test('every column the code selects exists', async () => {
    const lists: Record<string, string> = { tasks: TASK_COLS, approvals: APPROVAL_COLS, goals: GOAL_COLS, events: EVENT_COLS, activity: ACTIVITY_COLS, profiles: BRIEF_COLS }
    for (const [table, cols] of Object.entries(lists)) {
      const rows = (await pg.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table],
      )).rows.map((r) => r.column_name)
      for (const col of cols.split(',')) expect(rows, `${table}.${col}`).toContain(col)
    }
  })

  test('every database function the code calls exists with those argument names', async () => {
    const src = ['store.ts', 'channel-db.ts', 'send-db.ts', 'mask-db.ts', 'cron-db.ts'].map((f) => readFileSync(join(import.meta.dir, '..', 'lib', f), 'utf8')).join('\n')
    const calls = [...src.matchAll(/\.rpc\('([a-z_]+)',\s*\{([^}]*)\}/g)]
    expect(calls.length).toBeGreaterThanOrEqual(26)
    for (const [, name, body] of calls) {
      const used = [...body.matchAll(/(p_[a-z_]+):/g)].map((m) => m[1])
      const fn = (await pg.query<{ args: string[] }>(
        `select proargnames as args from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [name],
      )).rows[0]
      expect(fn, `function ${name}`).toBeDefined()
      for (const arg of used) expect(fn.args, `${name}(${arg})`).toContain(arg)
    }
  })

  test('every table has row level security on, and no policy allows delete', async () => {
    const tables = (await pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    )).rows
    expect(tables.length).toBe(14)
    for (const t of tables) expect(t.relrowsecurity, t.relname).toBe(true)
    const deletes = (await pg.query(`select 1 from pg_policies where schemaname = 'public' and cmd in ('DELETE', 'ALL')`)).rows
    expect(deletes).toEqual([])
  })
})
