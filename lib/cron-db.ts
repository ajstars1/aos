// The timer's only way into the database. It uses the secret key, so it exposes exactly four calls, each a database
// function that returns or changes as little as the timer needs (see the scheduled-sends and briefs migrations).
// Sending itself goes through lib/send-db.ts, like every other send.
import type { BriefData, BriefKind, BriefTarget } from './brief'
import { secretClient as db } from './secret-client'

export interface DueSend {
  user_id: string
  id: number
  // the person's linked Telegram chat, to tell them what happened; null when none
  chat_id: string | null
}

export const dueSends = async (limit: number): Promise<DueSend[]> => {
  const { data, error } = await db().rpc('cron_due_sends', { p_limit: limit })
  if (error) throw new Error(error.message)
  return (data ?? []) as DueSend[]
}

export const briefTargets = async (): Promise<BriefTarget[]> => {
  const { data, error } = await db().rpc('brief_targets', {})
  if (error) throw new Error(error.message)
  return (data ?? []) as BriefTarget[]
}

// Null when this message was already taken for that day, is switched off, or the chat is no longer linked.
export const claimBrief = async (userId: string, kind: BriefKind, day: string, from: Date, to: Date): Promise<BriefData | null> => {
  const { data, error } = await db().rpc('brief_claim', {
    p_user: userId,
    p_kind: kind,
    p_day: day,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  })
  if (error) throw new Error(error.message)
  return (data ?? null) as BriefData | null
}

export const finishBrief = async (userId: string, kind: BriefKind, day: string, ok: boolean): Promise<void> => {
  const { error } = await db().rpc('brief_finish', { p_user: userId, p_kind: kind, p_day: day, p_ok: ok })
  if (error) throw new Error(error.message)
}
