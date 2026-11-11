import { afterEach, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { GET } from '../app/api/cron/route'
import type { BriefData, BriefKind, BriefTarget } from '../lib/brief'
import { cronAuthorized, runCron, type CronDeps } from '../lib/cron'
import type { DueSend } from '../lib/cron-db'
import type { SendOutcome } from '../lib/sender'
import { TelegramRefused, type Button } from '../lib/telegram'

const SECRET = 'cron-secret-0123456789abcdef'

describe('who may run the timer', () => {
  test('only "Bearer <CRON_SECRET>", exactly', () => {
    expect(cronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true)
    for (const h of [null, '', SECRET, `bearer ${SECRET}`, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, 'Bearer ', `Bearer  ${SECRET}`, `Basic ${SECRET}`]) {
      expect(cronAuthorized(h, SECRET)).toBe(false)
    }
  })

  describe('the route', () => {
    const saved = { cron: process.env.CRON_SECRET, key: process.env.SUPABASE_SECRET_KEY }
    afterEach(() => {
      const put = (k: string, v: string | undefined): void => {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      put('CRON_SECRET', saved.cron)
      put('SUPABASE_SECRET_KEY', saved.key)
    })
    const call = (auth?: string): Promise<Response> =>
      GET(new NextRequest('https://aos.test/api/cron', { headers: auth ? { authorization: auth } : {} }))

    test('503 when CRON_SECRET is missing or unusable, before looking at the caller', async () => {
      delete process.env.CRON_SECRET
      expect((await call(`Bearer ${SECRET}`)).status).toBe(503)
      process.env.CRON_SECRET = 'short'
      expect((await call('Bearer short')).status).toBe(503)
      process.env.CRON_SECRET = 'has a space in it, 1234'
      expect((await call('Bearer has a space in it, 1234')).status).toBe(503)
    })

    test('401 for no header or a wrong secret, and the body says nothing more', async () => {
      process.env.CRON_SECRET = SECRET
      for (const auth of [undefined, 'Bearer wrong-secret-0123456789', SECRET]) {
        const res = await call(auth)
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'Unauthorized' })
      }
    })

    test('503 when the right caller comes but the database key is missing', async () => {
      process.env.CRON_SECRET = SECRET
      delete process.env.SUPABASE_SECRET_KEY
      expect((await call(`Bearer ${SECRET}`)).status).toBe(503)
    })
  })
})

// A stand-in for the database's brief_log: one message per person, kind and day; a refused one may be retried
// up to 3 times. The real rule is tested against the real migration in db.test.ts.
const fakeLog = () => {
  const log = new Map<string, { state: 'sending' | 'sent' | 'failed'; tries: number }>()
  const claim = (userId: string, kind: BriefKind, day: string): boolean => {
    const k = `${userId}|${kind}|${day}`
    const row = log.get(k)
    if (!row) {
      log.set(k, { state: 'sending', tries: 1 })
      return true
    }
    if (row.state === 'failed' && row.tries < 3) {
      log.set(k, { state: 'sending', tries: row.tries + 1 })
      return true
    }
    return false
  }
  const finish = (userId: string, kind: BriefKind, day: string, ok: boolean): void => {
    const k = `${userId}|${kind}|${day}`
    const row = log.get(k)
    if (row?.state === 'sending') log.set(k, { ...row, state: ok ? 'sent' : 'failed' })
  }
  return { log, claim, finish }
}

const NOW = new Date('2026-11-11T02:45:00Z') // 08:15 in India, 21:45 (10 Nov) in New York

const target = (user_id: string, timezone: string): BriefTarget => ({
  user_id, timezone, brief_hour: 8, evening_hour: 21, brief_on: true, evening_on: true,
})

const brief = (chat: string, over: Partial<BriefData> = {}): BriefData => ({
  chat_id: chat, timezone: 'Asia/Kolkata', tasks: [], approvals: [], waiting: 0, goals: [], events: [],
  done: ['Secret project call'], done_count: 1, sent_count: 0, ...over,
})

interface Delivered {
  chat: string
  text: string
  buttons?: Button[][]
}

const harness = (
  opts: {
    due?: DueSend[]
    outcomes?: Record<number, SendOutcome>
    targets?: BriefTarget[]
    chats?: Record<string, string>
    canSend?: boolean
    telegram?: boolean
    timeLeft?: number
    refuse?: (chat: string, n: number) => unknown
  } = {},
) => {
  const db = fakeLog()
  const sentIds: number[] = []
  const delivered: Delivered[] = []
  const finished: Array<[string, BriefKind, string, boolean]> = []
  let attempts = 0
  const deps: CronDeps = {
    now: () => NOW,
    timeLeft: () => opts.timeLeft ?? 200_000,
    canSend: opts.canSend ?? true,
    dueSends: async () => opts.due ?? [],
    send: async (_user, id) => {
      sentIds.push(id)
      return opts.outcomes?.[id] ?? { kind: 'sent', to: 'priya@example.com' }
    },
    targets: async () => opts.targets ?? [],
    claimBrief: async (userId, kind, day, from, to) => {
      expect(to.getTime()).toBeGreaterThan(from.getTime())
      return db.claim(userId, kind, day) ? brief(opts.chats?.[userId] ?? '1', { timezone: userId === 'ny' ? 'America/New_York' : 'Asia/Kolkata' }) : null
    },
    finishBrief: async (userId, kind, day, ok) => {
      finished.push([userId, kind, day, ok])
      db.finish(userId, kind, day, ok)
    },
    telegram:
      opts.telegram === false
        ? null
        : async (chat, text, buttons) => {
            attempts++
            const err = opts.refuse?.(chat, attempts)
            if (err) throw err
            delivered.push({ chat, text, buttons })
          },
  }
  return { deps, db, sentIds, delivered, finished }
}

describe('scheduled sends', () => {
  test('each due draft goes through the sealed send; the person hears what happened', async () => {
    const h = harness({
      due: [
        { user_id: 'u1', id: 11, chat_id: '100' },
        { user_id: 'u1', id: 12, chat_id: '100' },
        { user_id: 'u2', id: 13, chat_id: null },
        { user_id: 'u2', id: 14, chat_id: '200' },
      ],
      outcomes: {
        12: { kind: 'blocked', reason: 'dev@example.com already got 2 emails from you in the last 30 days' },
        14: { kind: 'not_sent', reason: 'the provider refused the login' },
      },
    })
    const report = await runCron(h.deps)
    expect(h.sentIds).toEqual([11, 12, 13, 14])
    expect(report.sends).toEqual({ sent: 2, skipped: 0, not_sent: 1, blocked: 1, refused: 0, unknown: 0 })
    // no chat for #13; #14 will be tried again by the next run, so it is not pinged
    expect(h.delivered.map((m) => [m.chat, m.text])).toEqual([
      ['100', '⏰ Scheduled: Draft #11 was sent to priya@example.com.'],
      ['100', '⏰ Scheduled: Draft #12 was not sent: dev@example.com already got 2 emails from you in the last 30 days.'],
    ])
    expect(JSON.stringify(report)).not.toContain('example.com')
  })

  test('nothing is sent without the vault key, and a run near its time limit stops starting sends', async () => {
    const off = harness({ due: [{ user_id: 'u1', id: 11, chat_id: null }], canSend: false })
    await runCron(off.deps)
    expect(off.sentIds).toEqual([])
    const late = harness({ due: [{ user_id: 'u1', id: 11, chat_id: null }], timeLeft: 30_000 })
    await runCron(late.deps)
    expect(late.sentIds).toEqual([])
  })

  test('a send that throws is counted as not sent and the run goes on', async () => {
    const h = harness({ due: [{ user_id: 'u1', id: 11, chat_id: null }, { user_id: 'u1', id: 12, chat_id: null }] })
    let first = true
    h.deps.send = async (_u, id) => {
      if (first) {
        first = false
        throw new Error('boom')
      }
      return { kind: 'sent', to: `#${id}` }
    }
    const r = await runCron(h.deps)
    expect([r.sends.not_sent, r.sends.sent]).toEqual([1, 1])
  })
})

describe('briefs', () => {
  test('due people get their message once, however often the timer runs', async () => {
    const h = harness({ targets: [target('india', 'Asia/Kolkata'), target('ny', 'America/New_York'), target('london', 'Europe/London')], chats: { india: '10', ny: '20', london: '30' } })
    const first = await runCron(h.deps)
    expect(first.briefs).toMatchObject({ morning: 1, evening: 1 })
    expect(h.delivered.map((m) => m.chat).sort()).toEqual(['10', '20'])
    expect(h.delivered.find((m) => m.chat === '10')?.text).toStartWith('Good morning. Wednesday 11 November.')
    expect(h.delivered.find((m) => m.chat === '20')?.text).toBe('Today: 1 done (Secret project call), no drafts waiting, nothing sent.')
    expect(h.finished.map((f) => f.slice(1))).toEqual(expect.arrayContaining([['morning', '2026-11-11', true], ['evening', '2026-11-10', true]]))

    const again = await runCron(h.deps)
    expect(again.briefs).toEqual({ morning: 0, evening: 0, refused: 0, skipped: 2 })
    expect(h.delivered.length).toBe(2)
    expect(JSON.stringify([first, again])).not.toContain('Secret')
  })

  test('a message Telegram refused is tried again by the next run; a timeout is not', async () => {
    const refused = harness({ targets: [target('india', 'Asia/Kolkata')], refuse: (_c, n) => (n === 1 ? new TelegramRefused('sendMessage', 429) : null) })
    expect((await runCron(refused.deps)).briefs.refused).toBe(1)
    expect(refused.delivered).toEqual([])
    expect((await runCron(refused.deps)).briefs.morning).toBe(1)
    expect(refused.delivered.length).toBe(1)

    const timeout = harness({ targets: [target('india', 'Asia/Kolkata')], refuse: (_c, n) => (n === 1 ? new Error('The operation timed out.') : null) })
    expect((await runCron(timeout.deps)).briefs.morning).toBe(1) // may have arrived: counted as sent
    expect(timeout.finished).toEqual([['india', 'morning', '2026-11-11', true]])
    await runCron(timeout.deps)
    expect(timeout.delivered).toEqual([])
  })

  test('without a bot there are no briefs and no pings, but scheduled sends still go', async () => {
    const h = harness({ telegram: false, targets: [target('india', 'Asia/Kolkata')], due: [{ user_id: 'u1', id: 11, chat_id: '100' }] })
    const r = await runCron(h.deps)
    expect(h.sentIds).toEqual([11])
    expect(r.briefs).toEqual({ morning: 0, evening: 0, refused: 0, skipped: 0 })
    expect(h.db.log.size).toBe(0)
  })

  test('a database error in one part does not stop the other', async () => {
    const h = harness({ targets: [target('india', 'Asia/Kolkata')] })
    h.deps.dueSends = async () => {
      throw new Error('db down')
    }
    const r = await runCron(h.deps)
    expect(r.errors).toBe(1)
    expect(r.briefs.morning).toBe(1)
  })
})
