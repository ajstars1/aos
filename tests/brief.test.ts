import { describe, expect, test } from 'bun:test'
import { dueBriefs, eveningText, morningMessages, slotFor, type BriefData, type BriefTarget } from '../lib/brief'
import type { Approval, Goal, Task } from '../lib/types'

const IST = 'Asia/Kolkata'
const NY = 'America/New_York'

describe('when a message is due', () => {
  test('08:00 in India is 02:30 UTC; due from then for four hours, never before', () => {
    expect(slotFor(new Date('2026-11-11T02:29:00Z'), IST, 8, 'morning')).toBeNull()
    const s = slotFor(new Date('2026-11-11T02:31:00Z'), IST, 8, 'morning')
    expect(s?.day).toBe('2026-11-11')
    expect(s?.at.toISOString()).toBe('2026-11-11T02:30:00.000Z')
    expect(s?.start.toISOString()).toBe('2026-11-10T18:30:00.000Z')
    expect(s?.end.toISOString()).toBe('2026-11-11T18:30:00.000Z')
    expect(slotFor(new Date('2026-11-11T06:29:00Z'), IST, 8, 'morning')?.day).toBe('2026-11-11')
    expect(slotFor(new Date('2026-11-11T06:30:00Z'), IST, 8, 'morning')).toBeNull()
  })

  test('an evening line at 23:00 sent after midnight belongs to the day before', () => {
    // 23:00 in New York on 11 Nov is 04:00 UTC on 12 Nov; this run is at 00:30 local on 12 Nov
    const s = slotFor(new Date('2026-11-12T05:30:00Z'), NY, 23, 'evening')
    expect(s?.day).toBe('2026-11-11')
    expect(s?.start.toISOString()).toBe('2026-11-11T05:00:00.000Z')
    expect(slotFor(new Date('2026-11-12T07:00:00Z'), NY, 23, 'evening')).toBeNull() // 02:00 local: three hours late
  })

  test('daylight saving ends: 08:00 is still 08:00 on the wall, and that day is 25 hours long', () => {
    // New York leaves daylight time on 1 Nov 2026. 08:00 EDT on 31 Oct = 12:00 UTC; 08:00 EST on 1 Nov = 13:00 UTC.
    expect(slotFor(new Date('2026-10-31T12:05:00Z'), NY, 8, 'morning')?.day).toBe('2026-10-31')
    expect(slotFor(new Date('2026-11-01T12:30:00Z'), NY, 8, 'morning')).toBeNull() // 07:30 on the wall
    const s = slotFor(new Date('2026-11-01T13:05:00Z'), NY, 8, 'morning')
    expect(s?.day).toBe('2026-11-01')
    expect(s?.at.toISOString()).toBe('2026-11-01T13:00:00.000Z')
    expect((s!.end.getTime() - s!.start.getTime()) / 3_600_000).toBe(25)
  })

  test('daylight saving starts: an hour that does not exist lands just after the jump', () => {
    // 8 Mar 2026: 02:00 jumps to 03:00 in New York. A brief at 02:00 goes at 03:00 EDT = 07:00 UTC.
    expect(slotFor(new Date('2026-03-08T06:30:00Z'), NY, 2, 'morning')).toBeNull() // 01:30 EST: not yet
    const s = slotFor(new Date('2026-03-08T07:10:00Z'), NY, 2, 'morning')
    expect(s?.day).toBe('2026-03-08')
    expect(s?.at.toISOString()).toBe('2026-03-08T07:00:00.000Z')
    expect((s!.end.getTime() - s!.start.getTime()) / 3_600_000).toBe(23)
  })

  test('each person on their own clock; switched-off messages and unknown zones', () => {
    const t = (over: Partial<BriefTarget>): BriefTarget => ({
      user_id: 'u', timezone: IST, brief_hour: 8, evening_hour: 21, brief_on: true, evening_on: true, ...over,
    })
    const now = new Date('2026-11-11T02:45:00Z') // 08:15 in India, 21:45 the day before in New York
    const due = dueBriefs(
      [t({ user_id: 'india' }), t({ user_id: 'ny', timezone: NY }), t({ user_id: 'off', brief_on: false }), t({ user_id: 'mars', timezone: 'Mars/Base' })],
      now,
    )
    expect(due.map((d) => [d.user_id, d.slot.kind, d.slot.day])).toEqual([
      ['india', 'morning', '2026-11-11'],
      ['ny', 'evening', '2026-11-10'],
      ['mars', 'morning', '2026-11-11'], // an unknown zone falls back to Asia/Kolkata
    ])
  })
})

const NOW = new Date('2026-11-11T02:45:00Z') // 08:15 in India
const iso = (s: string): string => new Date(s).toISOString()

const task = (id: number, title: string, due: string | null, over: Partial<Task> = {}): Task => ({
  id, title, area: 'general', owner: 'me', status: 'todo', due_at: due, recur: null, notes: null, goal_id: null, parent_id: null,
  created_at: iso('2026-11-01T00:00:00Z'), updated_at: iso('2026-11-01T00:00:00Z'), ...over,
})

const goal = (id: number, title: string, current: number, target: number, due: string): Goal => ({
  id, title, area: 'general', unit: 'orders', target, current, due_at: due, status: 'active', created_at: iso('2026-11-01T00:00:00Z'),
})

const draft = (id: number): Approval => ({
  id, task_id: null, channel: 'email', recipient: 'priya@example.com', subject: 'Quote', draft: `Draft text ${id}`, status: 'pending',
  result: null, send_after: null, created_at: iso('2026-11-10T00:00:00Z'), decided_at: null,
})

const data = (over: Partial<BriefData> = {}): BriefData => ({
  chat_id: '42', timezone: IST, tasks: [], approvals: [], waiting: 0, goals: [], events: [], done: [], done_count: 0, sent_count: 0, ...over,
})

describe('the morning brief', () => {
  const slot = slotFor(NOW, IST, 8, 'morning')!

  test('due today with late ones first, the calendar, goals off pace only, then drafts with buttons', () => {
    const msgs = morningMessages(
      data({
        tasks: [
          task(1, 'Call the CA', '2026-11-11T09:00:00Z'), // 14:30 today
          task(2, 'Send the invoice', '2026-11-09T05:00:00Z'), // two days late
          task(3, 'Next week thing', '2026-11-18T05:00:00Z'),
          task(4, 'Someday', null),
        ],
        events: [{ id: 1, title: 'Demo with Ravi', area: 'general', starts_at: '2026-11-11T10:30:00Z', ends_at: null, location: 'Zoom', notes: null }],
        goals: [goal(1, 'Ten orders', 1, 10, '2026-11-21T00:00:00Z'), goal(2, 'Two calls', 2, 2, '2026-11-30T00:00:00Z')],
        approvals: [draft(7), draft(8)],
        waiting: 2,
      }),
      NOW,
      slot,
    )
    expect(msgs[0].text).toBe(
      [
        'Good morning. Wednesday 11 November.',
        '',
        'Due today (2)',
        '- Send the invoice (late, was due Mon, 9 Nov, 10:30 am)',
        '- Call the CA (2:30 pm)',
        '',
        'Calendar',
        '- 4:00 pm Demo with Ravi @ Zoom',
        '',
        'Goals off pace',
        '- goal #1 Ten orders: 1 of 10 orders, due 21 Nov (behind: about 5.1 expected by now)',
        '',
        'Drafts waiting for your yes: 2. Here they are.',
      ].join('\n'),
    )
    expect(msgs.length).toBe(3)
    expect(msgs[1].text).toStartWith('Draft #7 · email to priya@example.com')
    expect(msgs[1].buttons?.[0].map((b) => b.callback_data)).toEqual(['a:7', 'r:7'])
    expect(msgs[0].buttons).toBeUndefined()
  })

  test('at most five drafts follow; the rest are counted', () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map(draft)
    const msgs = morningMessages(data({ approvals: many, waiting: 9 }), NOW, slot)
    expect(msgs.length).toBe(6)
    expect(msgs[0].text).toContain('Drafts waiting for your yes: 9. The first 5 follow; /drafts shows the rest.')
  })

  test('a quiet day says so in one line', () => {
    const msgs = morningMessages(data({ tasks: [task(3, 'Next week thing', '2026-11-18T05:00:00Z')] }), NOW, slot)
    expect(msgs).toEqual([{ text: 'Good morning. Wednesday 11 November.\n\nNothing due today, no drafts waiting, and your goals are on pace.' }])
  })

  test('today is the person\'s today, not UTC\'s', () => {
    // 20:00 UTC on 11 Nov is already 12 Nov in India: not due "today" for a brief on 11 Nov
    const msgs = morningMessages(data({ tasks: [task(9, 'Tomorrow in India', '2026-11-11T20:00:00Z')] }), NOW, slot)
    expect(msgs[0].text).not.toContain('Tomorrow in India')
  })
})

describe('the evening line', () => {
  test('done, waiting and sent in one line', () => {
    expect(eveningText(data({ done: ['Call the CA', 'Send the invoice'], done_count: 2, waiting: 1, sent_count: 3 }))).toBe(
      'Today: 2 done (Call the CA, Send the invoice), 1 draft waiting for your yes, 3 sent.',
    )
    expect(eveningText(data({ done: ['A1', 'B2', 'C3', 'D4'], done_count: 6, waiting: 2 }))).toBe(
      'Today: 6 done (A1, B2, C3, and 3 more), 2 drafts waiting for your yes, nothing sent.',
    )
    expect(eveningText(data())).toBe('Today: nothing marked done, no drafts waiting, nothing sent.')
  })
})
