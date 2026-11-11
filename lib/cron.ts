// The timer: what one run of the cron route does. Effects are passed in, so the whole run is tested without a
// network, a database or a clock. Every step is safe to repeat: a send is claimed in the database before it goes
// out (at most once), and each brief is claimed per person, message and local day (at most once).
import { createHash, timingSafeEqual } from 'node:crypto'
import { dueBriefs, eveningText, morningMessages, type BriefData, type BriefKind, type BriefTarget, type OutMessage } from './brief'
import type { DueSend } from './cron-db'
import { outcomeLine, type SendOutcome } from './sender'
import { TelegramRefused, type Button } from './telegram'

// "Authorization: Bearer <secret>", compared in constant time (hashes first, so the length does not leak either).
export const cronAuthorized = (header: string | null, secret: string): boolean => {
  const m = /^Bearer (\S+)$/.exec(header ?? '')
  if (!m) return false
  const a = createHash('sha256').update(m[1]).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

export interface CronDeps {
  now: () => Date
  // milliseconds left before the run should stop starting new work
  timeLeft: () => number
  // false when the vault key is missing: then nothing is sent
  canSend: boolean
  dueSends: (limit: number) => Promise<DueSend[]>
  send: (userId: string, id: number) => Promise<SendOutcome>
  targets: () => Promise<BriefTarget[]>
  claimBrief: (userId: string, kind: BriefKind, day: string, from: Date, to: Date) => Promise<BriefData | null>
  finishBrief: (userId: string, kind: BriefKind, day: string, ok: boolean) => Promise<void>
  // null when the Telegram bot is not set up: then no briefs and no pings
  telegram: ((chatId: string, text: string, buttons?: Button[][]) => Promise<void>) | null
}

type Kind = SendOutcome['kind']

export interface CronReport {
  sends: Record<Kind, number>
  briefs: { morning: number; evening: number; refused: number; skipped: number }
  errors: number
}

// Sends are slow (an SMTP login each), so a run takes a batch and leaves the rest for the next run.
export const SEND_BATCH = 40
const SEND_MARGIN_MS = 60_000
const BRIEF_MARGIN_MS = 20_000
const BRIEF_PARALLEL = 5

// What the person hears about a send the timer made. Quiet outcomes, and "not sent" (retried by the next run, up
// to 3 tries), are not pinged, so a stuck draft cannot fill their chat.
const PINGED = new Set<Kind>(['sent', 'refused', 'unknown', 'blocked'])

const runSends = async (d: CronDeps, r: CronReport): Promise<void> => {
  if (!d.canSend) return
  let due: DueSend[]
  try {
    due = await d.dueSends(SEND_BATCH)
  } catch {
    r.errors++
    return
  }
  for (const s of due) {
    if (d.timeLeft() < SEND_MARGIN_MS) break
    const id = Number(s.id)
    const outcome = await d.send(s.user_id, id).catch((): SendOutcome => ({ kind: 'not_sent', reason: 'something went wrong' }))
    r.sends[outcome.kind]++
    if (d.telegram && s.chat_id && PINGED.has(outcome.kind)) {
      await d.telegram(s.chat_id, `⏰ Scheduled: ${outcomeLine(id, outcome)}`).catch(() => undefined)
    }
  }
}

// Delivers one message set. The first message decides the outcome: refused by Telegram means nothing arrived and it
// may be tried again; any other failure (a timeout) may have arrived, so it counts as sent and is never repeated.
const deliver = async (send: NonNullable<CronDeps['telegram']>, chatId: string, msgs: OutMessage[]): Promise<boolean> => {
  const [first, ...rest] = msgs
  try {
    await send(chatId, first.text, first.buttons)
  } catch (e) {
    if (e instanceof TelegramRefused) return false
    return true
  }
  for (const m of rest) await send(chatId, m.text, m.buttons).catch(() => undefined)
  return true
}

const runBriefs = async (d: CronDeps, r: CronReport): Promise<void> => {
  const send = d.telegram
  if (!send) return
  let targets: BriefTarget[]
  try {
    targets = await d.targets()
  } catch {
    r.errors++
    return
  }
  const now = d.now()
  const queue = dueBriefs(targets, now)
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if (d.timeLeft() < BRIEF_MARGIN_MS) return
      const { user_id: userId, slot } = job
      try {
        const data = await d.claimBrief(userId, slot.kind, slot.day, slot.start, slot.end)
        if (!data) {
          r.briefs.skipped++
          continue
        }
        const msgs = slot.kind === 'morning' ? morningMessages(data, now, slot) : [{ text: eveningText(data) }]
        const ok = await deliver(send, data.chat_id, msgs)
        await d.finishBrief(userId, slot.kind, slot.day, ok)
        if (ok) r.briefs[slot.kind]++
        else r.briefs.refused++
      } catch {
        r.errors++
      }
    }
  }
  await Promise.all(Array.from({ length: BRIEF_PARALLEL }, worker))
}

// One run. The report holds counts only: no names, addresses or text.
export const runCron = async (d: CronDeps): Promise<CronReport> => {
  const r: CronReport = {
    sends: { sent: 0, skipped: 0, not_sent: 0, blocked: 0, refused: 0, unknown: 0 },
    briefs: { morning: 0, evening: 0, refused: 0, skipped: 0 },
    errors: 0,
  }
  await Promise.all([runSends(d, r), runBriefs(d, r)])
  return r
}
