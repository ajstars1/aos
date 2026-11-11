import { NextResponse, type NextRequest } from 'next/server'
import { briefTargets, claimBrief, dueSends, finishBrief } from '../../../lib/cron-db'
import { cronAuthorized, runCron } from '../../../lib/cron'
import { channelEnv, cronSecret } from '../../../lib/env'
import { sendForUser } from '../../../lib/sender'
import { sendText } from '../../../lib/telegram'
import { vaultKey } from '../../../lib/vault'

export const dynamic = 'force-dynamic'
// The most Vercel Hobby allows. A run stops starting new work well before this.
export const maxDuration = 300
const BUDGET_MS = 240_000

// The timer. Vercel Cron calls it (see vercel.json) with "Authorization: Bearer <CRON_SECRET>"; nothing else gets in.
// It sends approved emails whose time has come and the morning brief and evening line that are due. Every part is
// claimed in the database first, so a repeated or overlapping run does nothing twice.
export const GET = async (req: NextRequest): Promise<NextResponse> => {
  const secret = cronSecret()
  if (!secret) return NextResponse.json({ error: 'The timer is not configured' }, { status: 503 })
  if (!cronAuthorized(req.headers.get('authorization'), secret)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const cfg = channelEnv()
  if (!cfg.secretKey) return NextResponse.json({ error: 'The timer is not configured' }, { status: 503 })

  const started = Date.now()
  const token = cfg.botToken
  try {
    const report = await runCron({
      now: () => new Date(),
      timeLeft: () => BUDGET_MS - (Date.now() - started),
      canSend: vaultKey() !== null,
      dueSends,
      send: sendForUser,
      targets: briefTargets,
      claimBrief,
      finishBrief,
      telegram: token ? (chatId, text, buttons) => sendText(token, chatId, text, buttons) : null,
    })
    return NextResponse.json(report)
  } catch {
    return NextResponse.json({ error: 'The timer run failed' }, { status: 500 })
  }
}
