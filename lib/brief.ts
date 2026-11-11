// The morning brief and the evening line: who is due right now in their own time zone, and what the messages say.
// Plain code over the same agenda logic as /today, no model. No clock or database of its own, so it is tested
// with fixed instants, including daylight-saving days.
import { buildAgenda, goalLine, goalPace } from './agenda'
import { clip, draftButtons, draftText, type Button } from './telegram'
import { DEFAULT_TZ, addDays, dayStart, fmtWhen, instantOf, isValidTimeZone, wallTime } from './time'
import type { Approval, CalendarEvent, Goal, Task } from './types'

export type BriefKind = 'morning' | 'evening'

// One linked person, as brief_targets() lists them.
export interface BriefTarget {
  user_id: string
  timezone: string
  brief_hour: number
  evening_hour: number
  brief_on: boolean
  evening_on: boolean
}

// What brief_claim() returns for one person: their own rows only.
export interface BriefData {
  chat_id: string
  timezone: string
  tasks: Task[]
  approvals: Approval[]
  waiting: number
  goals: Goal[]
  events: CalendarEvent[]
  done: string[]
  done_count: number
  sent_count: number
}

// How long after its hour a message may still go out. On Vercel Hobby the timer runs about once an hour and each
// run lands anywhere in its hour, so two runs can be up to two hours apart. Past this, that day's message is skipped
// rather than arriving at an odd time.
export const LATE_LIMIT_H: Record<BriefKind, number> = { morning: 4, evening: 3 }

export interface Slot {
  kind: BriefKind
  // the person's local date the message belongs to, YYYY-MM-DD
  day: string
  // the instant of the chosen hour on that date
  at: Date
  // that local date's bounds
  start: Date
  end: Date
}

const pad = (n: number): string => String(n).padStart(2, '0')

// The message slot `now` falls in: the latest occurrence of hour:00 in the zone at or before now, if now is still
// within the late limit after it. A slot can belong to yesterday's date (an evening line at 23:00 sent at 00:30).
export const slotFor = (now: Date, tz: string, hour: number, kind: BriefKind): Slot | null => {
  const w = wallTime(now, tz)
  let at = instantOf({ ...w, hour, minute: 0, second: 0 }, tz)
  if (at.getTime() > now.getTime()) at = instantOf({ ...w, day: w.day - 1, hour, minute: 0, second: 0 }, tz)
  if (now.getTime() - at.getTime() >= LATE_LIMIT_H[kind] * 3_600_000) return null
  const start = dayStart(at, tz)
  const d = wallTime(at, tz)
  return { kind, day: `${d.year}-${pad(d.month)}-${pad(d.day)}`, at, start, end: addDays(start, 1, tz) }
}

export const zoneOf = (tz: string | null | undefined): string => (tz && isValidTimeZone(tz) ? tz : DEFAULT_TZ)

// Every message that is due now. brief_claim() then makes sure each goes out at most once.
export const dueBriefs = (targets: BriefTarget[], now: Date): Array<{ user_id: string; slot: Slot }> => {
  const out: Array<{ user_id: string; slot: Slot }> = []
  for (const t of targets) {
    const tz = zoneOf(t.timezone)
    const morning = t.brief_on ? slotFor(now, tz, t.brief_hour, 'morning') : null
    const evening = t.evening_on ? slotFor(now, tz, t.evening_hour, 'evening') : null
    if (morning) out.push({ user_id: t.user_id, slot: morning })
    if (evening) out.push({ user_id: t.user_id, slot: evening })
  }
  return out
}

export interface OutMessage {
  text: string
  buttons?: Button[][]
}

const MAX_LINES = 10
const MAX_DRAFTS = 5

const short = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const fmtTime = (iso: string, tz: string): string =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })

const fmtDate = (d: Date, tz: string): string =>
  d.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' })

const capped = (lines: string[]): string[] =>
  lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `- and ${lines.length - MAX_LINES} more`] : lines

// Due today (late ones first), today's calendar, goals off pace, then each waiting draft with Approve / Reject.
export const morningMessages = (data: BriefData, now: Date, slot: Slot): OutMessage[] => {
  const tz = zoneOf(data.timezone)
  const a = buildAgenda(
    { tasks: data.tasks, approvals: data.approvals, goals: data.goals, events: data.events },
    { start: slot.start, endToday: slot.end, end: slot.end },
  )
  const out: string[] = [`Good morning. ${fmtDate(slot.at, tz)}.`]
  const due = [
    ...a.overdue.map((t) => `- ${short(t.title)} (late, was due ${fmtWhen(t.due_at, tz)})`),
    ...a.today.map((t) => `- ${short(t.title)} (${t.due_at ? fmtTime(t.due_at, tz) : 'today'})`),
  ]
  if (due.length) out.push('', `Due today (${due.length})`, ...capped(due))
  if (a.events.length) {
    out.push('', 'Calendar', ...capped(a.events.map((e) => `- ${fmtTime(e.starts_at, tz)} ${short(e.title)}${e.location ? ` @ ${short(e.location, 40)}` : ''}`)))
  }
  const off = a.goals.filter((g) => {
    const p = goalPace(g, now).pace
    return p === 'behind' || p === 'late'
  })
  if (off.length) out.push('', 'Goals off pace', ...capped(off.map((g) => `- ${goalLine(g, now, tz)}`)))
  const waiting = Math.max(data.waiting, data.approvals.length)
  if (waiting) {
    const shown = Math.min(MAX_DRAFTS, data.approvals.length)
    out.push('', `Drafts waiting for your yes: ${waiting}.${shown ? ` ${shown === waiting ? 'Here they are' : `The first ${shown} follow; /drafts shows the rest`}.` : ''}`)
  }
  if (!due.length && !a.events.length && !off.length && !waiting) out.push('', 'Nothing due today, no drafts waiting, and your goals are on pace.')
  return [
    { text: clip(out.join('\n')) },
    ...data.approvals.slice(0, MAX_DRAFTS).map((d) => ({ text: draftText(d), buttons: draftButtons(d.id) })),
  ]
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// One line: what got done today, what is waiting, what went out.
export const eveningText = (data: BriefData): string => {
  const names = data.done.slice(0, 3).map((t) => short(t, 50))
  const more = data.done_count - names.length
  const done = data.done_count
    ? `${data.done_count} done (${names.join(', ')}${more > 0 ? `, and ${more} more` : ''})`
    : 'nothing marked done'
  const waiting = data.waiting ? `${plural(data.waiting, 'draft', 'drafts')} waiting for your yes` : 'no drafts waiting'
  const sent = data.sent_count ? `${data.sent_count} sent` : 'nothing sent'
  return clip(`Today: ${done}, ${waiting}, ${sent}.`)
}
