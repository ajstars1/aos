# aos

[![CI](https://github.com/ajstars1/aos/actions/workflows/ci.yml/badge.svg)](https://github.com/ajstars1/aos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A multi-user version of the aos core that anyone adds to the AI assistant they already use (Claude, ChatGPT, any MCP client) by pasting one link. Nothing to install, works on Mac, Windows, Linux and phones.

It grew out of **aos control**, Ayush's personal setup on his own Linux PC (private, not in this repo). This is the version for everyone, with its **own database**; the two share no data and no code at runtime.

## Start using it

**Why it works on Mac, Windows, Linux and phones:** nothing runs on your computer. aos is a website plus a connector link. Your AI assistant (the Claude or ChatGPT app you already have, on any system) calls aos over the internet, so whatever runs your assistant runs aos.

1. Open **https://aos-connect.vercel.app** and sign in with Google.
2. On your page, copy the connector link: `https://aos-connect.vercel.app/api/mcp`
3. Add it to your assistant:
   - **Claude** (claude.ai, the desktop app on Mac or Windows, or Claude Code): Settings → Connectors → Add custom connector → paste the link → Connect, then press **Allow** on the aos page that opens. Connectors added on claude.ai also show up in the Claude phone app.
   - **ChatGPT:** Settings → Connectors (or Apps) → add a custom connector with the same link. Custom connectors need a plan and settings that allow them.
   - **Any other MCP client** that supports remote servers with OAuth: give it the same link.
4. Ask your assistant: *"what's on my aos agenda today?"*
5. Optional: on your aos page, connect Telegram so drafts reach your phone with Approve / Reject buttons, and connect your mailbox so approved emails send by themselves.

| | Mac | Windows | Linux | Phone |
|---|---|---|---|---|
| **aos connect** (this folder): tasks, drafts you approve, goals, sealed and scheduled email send, Telegram with a daily brief | ✅ | ✅ | ✅ | ✅ |
| **aos control** (private, not in this repo): the agent that works on its own on a PC, desk control, power-on, Discord | ❌ | ❌ | ✅ (Ayush's setup: systemd, tmux, Hyprland) | via Discord |

**Status (11 Nov 2026):** the app, the connector link and the OAuth flow up to the sign-in page are live and checked. A full run by a person (Google sign-in → add the connector in Claude → first tool call) has not been done yet; until it has, treat this as an early preview.

**Phase B (scheduled sends, the per-recipient cap, morning brief and evening line):** built and tested against the real migrations on an in-process database only. It is not deployed, its two migrations (`20261111120000_scheduled_sends.sql`, `20261111130000_briefs.sql`) are not on the live database, and no cron run has happened on Vercel yet.

```
person's assistant (Claude / ChatGPT)
   │  1. add connector: https://<app>/api/mcp
   │  2. 401 + link to /.well-known/oauth-protected-resource
   ▼
Supabase Auth (OAuth 2.1 server, sign-in with Google)
   │  3. person signs in, sees /oauth/consent, presses Allow
   ▼
/api/mcp  ── every tool call runs with that person's own token ──►  Postgres (row level security)
/app      ── the person's page: approve or reject drafts, goals, today, connected apps
```

## What a connected assistant can do

18 tools: `agenda`, `task_list`, `task_add`, `task_update`, `task_done`, `task_delete`, `approval_request`, `approval_list`, `approval_send`, `approval_mark_sent`, `api_request`, `activity_log`, `activity_recent`, `goal_set`, `goal_list`, `goal_progress`, `event_add`, `settings`.

There is **no tool to approve a draft**. The assistant writes the text with `approval_request`; the person presses yes or no on `/app`; the assistant then sends the approved text and calls `approval_mark_sent`.

## Where the rules live

Every user, and every app they connect, holds a real Supabase token and could call the database API directly. So the rules are in the database (`supabase/migrations/`), not only in this app:

| Rule | How |
|---|---|
| A user reads and writes only their own rows | Row level security on every table, `user_id = auth.uid()` |
| A row cannot point at another user's task or goal | Composite foreign keys `(user_id, id)` |
| An assistant can never approve its own draft | Trigger `guard_approval`: tokens with a `client_id` claim (issued to an app) are refused |
| An approved text cannot be changed, and only an approved draft can be marked sent | Same trigger |
| Nothing is hard-deleted | No delete policy, delete privilege revoked; `deleted_at` only |
| One user cannot fill the database | Row quotas per table, size checks on every text column |
| Rate limit (120 tool calls a minute per user) | `hit_rate()`; users cannot read or reset the counter |
| An assistant cannot swap a draft's text after asking | Trigger `guard_approval`: content changes from a token with a `client_id` are refused |
| A saved login cannot be read back by anyone | `secrets.ciphertext` has no select grant; it is sealed with a key that is not in the database; only `send_claim()` (server secret key) returns it |
| Only the person can save or remove a login | `put_secret()` / `remove_secret()` refuse tokens with a `client_id`; a connected app sees no rows in `secrets` |
| An email is sent at most once, and at most 50 a day | `send_claim()` takes the draft for one sender; `send_finish()` records the outcome |
| A saved API key can only go to the host the person entered | The host is stored with the key by `put_secret()` (public DNS names only) and is never taken from an assistant; the socket refuses private addresses at connect time |
| A request that changes something runs only after the person's yes, exactly as shown | `request_action()` writes the row and its text from the same data; `guard_approval` refuses hand-written, edited or self-finished API requests |
| An assistant cannot turn a stand-in back into a value, or switch masking off | `handles` is closed to tokens with a `client_id`; `handles_resolve()` is server only; `guard_profile` refuses `mask_level` changes from an app |
| Only the person can link a phone | `create_link_code()` refuses tokens with a `client_id`; codes are one-time, 15 minutes, stored hashed |
| A phone decides only its own person's drafts | `channel_*` functions run only with the server secret key and scope every query to the linked user; 60 messages a minute |
| At most 2 emails to one address in 30 days | `send_claim()` refuses a third (`touch_block()`); the draft stays approved and its result says why. Touches are written by a trigger into `touches`, which no user or app can read or change; soft-deleting old drafts does not lift the cap |
| A scheduled email goes out once, after its time | The timer uses the same `send_claim()` / `send_finish()` as a yes on `/app`; `cron_due_sends()` (server key only) lists due drafts and skips capped ones and drafts tried 3 times |
| A morning brief or evening line at most once a day | `brief_claim()` (server key only) takes one message per person, kind and local date in `brief_log`; a repeated or overlapping timer run gets nothing |
| Only the timer runs the timer | `/api/cron` needs `Authorization: Bearer <CRON_SECRET>` (compared in constant time); 401 otherwise, 503 when `CRON_SECRET` is not set |

Reads and writes of a person's data always run with that person's own token. The Supabase secret key is used through four small files, each a short list of database functions: the Telegram webhook (`lib/channel-db.ts`), sending an approved email or request (`lib/send-db.ts`), masking plus reading a saved key (`lib/mask-db.ts`: `handles_mask`, `handles_resolve`, `api_key_read`), and the timer (`lib/cron-db.ts`: `cron_due_sends`, `brief_targets`, `brief_claim`, `brief_finish`). The MCP endpoint accepts only tokens issued to a connected app; the person's own website session never passes through an assistant.

## Tests

`bun test` (175 tests):

- `tests/db.test.ts` runs the real migrations on an in-process Postgres (PGlite) and attacks them as a second user and as a connected app. It also checks that every column and database function the code names exists in the schema. Since phase B it covers the touch cap (case and display name do not matter, an assistant's own sends count, another person's do not, nobody can read or change the counter, soft-deleting does not lift it, 30 days do), the list of due scheduled emails, and the brief functions (once per person and day, three tries after a refusal, off means off, an unlinked chat gets nothing, only that person's data).
- `tests/vault.test.ts` covers sealing (wrong key, wrong owner and changed values do not open), the mail rules, a real SMTP exchange against a local server (login check, the approved text arriving word for word, header injection, a refused recipient), and the whole sealed send with its failure paths.
- `tests/privacy.test.ts` covers finding contact details (and not mistaking ids, amounts or dates for phone numbers), masking and putting values back, the privacy levels, which addresses a key may be sent to, real HTTP exchanges against a local server (key header, body word for word, no redirects followed, size cap), and a read for an assistant end to end.
- `tests/bot.test.ts` covers the Telegram bot: commands, yes/no, buttons, the webhook secret check, unlinked chats, group chats ignored, and that only our own error messages reach the chat.
- `tests/lib.test.ts` covers time zones (including daylight-saving days and a wall time that does not exist), repeating tasks, the agenda, goal pace, the redirect guard and the tool wrapper.
- `tests/brief.test.ts` covers when a morning brief or evening line is due (India at 08:00 is 02:30 UTC, an evening line sent after midnight, both New York daylight-saving changes) and what they say.
- `tests/cron.test.ts` covers the timer: the `CRON_SECRET` check and the route's 401 and 503, scheduled sends and what the person is told, briefs going out once however often the timer runs, a refused message tried again, a timed-out one not, and one broken part not stopping the other.

Checked by hand on a local build with placeholder settings: the landing page, the OAuth metadata document, `401` with the discovery header for no token, a garbage token and a forged unsigned token, and the redirects to sign-in.

**Not tested yet:** a real Google sign-in, tool calls through Supabase's REST API, and connecting from Claude and ChatGPT (see "Live" below).

## Live

- **App:** https://aos-connect.vercel.app (Vercel project `aos-connect`, deployed from this folder with `vercel deploy --prod`).
- **Connector link:** `https://aos-connect.vercel.app/api/mcp`
- **Database and sign-in:** Supabase project `aos-connect` (ref `peruwdunukezbyojebvb`, Mumbai). Separate from `aos-control`.

How it was set up (10 Nov 2026), so it can be repeated:

1. `supabase projects create aos-connect --region ap-south-1`, then `supabase link` and `supabase db push`. The database password is in `.env.supabase.local` (git-ignored, never uploaded: see `.vercelignore`).
2. Sign-in settings live in `supabase/config.toml` and are applied with `npx supabase@3.1.0 config push` (the 2.x CLI cannot push the OAuth server settings). They turn on the OAuth server (consent page `/oauth/consent`, dynamic client registration), turn off email sign-up, and allow the redirects `https://aos-connect.vercel.app/auth/callback` and `http://localhost:3000/auth/callback`.
3. Google sign-in: a Google Cloud OAuth client (type Web) with the redirect `https://peruwdunukezbyojebvb.supabase.co/auth/v1/callback`, entered in Supabase → Authentication → Sign In / Providers → Google. Basic scopes only, so no Google review.
4. Token signing uses the project's default asymmetric key (ES256), so tokens are checked without a network call.
5. Vercel variables (production): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL=https://aos-connect.vercel.app`, plus the server-only ones for the phone and the vault: `SUPABASE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `NEXT_PUBLIC_TELEGRAM_BOT`, `VAULT_KEY`, and for the timer `CRON_SECRET` (see "Working on its own" below). `VAULT_KEY` is also in `.env.local`; if it is lost, saved logins cannot be opened and people reconnect their email.

Checked live: the landing page, `401` with the discovery header, the protected-resource document, a fake token refused, `/app` redirecting to sign-in, and a full app registration → authorize → consent page → sign-in redirect. Row level security, the no-delete rule and the approval guard were re-checked on the live database inside a rolled-back transaction.

**Still to try by a person:** sign in with Google, add the connector link in Claude (Settings → Connectors → Add custom connector), press Allow, and ask "what is on my aos agenda today?".

## The vault and sealed sending

The rule: **the model works with names and drafts; the server holds the secrets and does the sending.**

- On `/app`, under **Email sending**, the person picks their mail provider and enters their address and an app password. The server checks the login with the provider, seals it (AES-256-GCM, key `VAULT_KEY` in the server environment, bound to that user) and stores only the sealed value. It is never shown again, to anyone.
- An assistant can learn one thing: that email is connected, with a hint like `a***@example.com` (`settings` tool). Its instructions tell it never to ask for a password or key in chat.
- When the person approves an email draft (on `/app` or with the Telegram button), aos sends it right away from their own mailbox, word for word, and logs it. The assistant takes no part.
- `approval_send` lets an assistant ask aos to send an email that is already approved (for example a scheduled one whose time has come). It returns one line; no login, no mail server reply.
- A draft is sent by aos only if its channel is `email`, its recipient holds exactly one address and it has a subject. Anything else stays approved for the assistant to send as before.
- If the provider refuses the login or the recipient, nothing was sent: the draft stays approved and can be sent again. If the connection breaks mid-send, the draft is marked failed and is never retried by itself.
- The mail server's address always comes from the fixed provider list in `lib/mail.ts`, never from input.

## Connected services (API keys)

- On `/app`, under **Connected services**, the person saves a key with a short name, the service address (for example `api.razorpay.com`) and how the service wants the key (Bearer, Basic, or a header of its own). It is sealed like the mail login.
- An assistant sees the names and hosts (`settings` tool) and calls `api_request` with a name and a path. It never sees the key and cannot choose the host.
- **GET runs at once.** The reply comes back with the key scrubbed out (also in encoded forms), contact details masked, compact, cut at 12,000 characters, and reduced to the `fields` asked for.
- **Anything else waits for a yes.** POST, PUT, PATCH and DELETE become an approval that shows the exact request. It runs when the person approves, on `/app` or from Telegram, and only if they ticked "allow requests that change something" for that key. The first part of the answer is stored with the approval.
- Guards: public hosts only (checked when saved, and again on the socket's own DNS lookup, so a name cannot be re-pointed at a private address), HTTPS only, redirects not followed, replies read up to 256 KB, 30 reads a minute, 200 approved requests a day, 20 keys per person.

## Masking

- An email address or phone number in a reply from a connected service reaches the assistant as a stand-in: `[EMAIL_12]`, `[PHONE_3]`. The same value always gets the same stand-in for that person, so the assistant can still follow who is who across conversations.
- When the assistant uses a stand-in (a draft's recipient, a request path or body), the server puts the real value back before it stores or sends. The person sees real values on `/app` and on their phone.
- Once a value has a stand-in, it is masked in every tool result, so it cannot be read back by saving it in a task and listing the task.
- The person chooses the level on `/app` under **Privacy**: services only (default), also their own tasks, drafts and log, or off. The same section has a "Who is this?" box that turns a stand-in back into the value, for the person only.
- If masking a service reply fails, the reply is not returned.

Limits, plainly: text the person types into their assistant's chat reaches the model before aos sees it; names in free text are not masked; a service that returns a value in a changed form (encoded, split) is not caught; phone numbers are found by pattern, so an unusual format can slip through and a ten-digit number in free text can be masked by mistake.

Not built yet: a look-up of stand-ins from Telegram.

## Phone (Telegram)

The person presses **Connect Telegram** on `/app`, Telegram opens, they press Start, and the chat is linked. From then on:

- every draft their assistant queues arrives in that chat with **Approve** and **Reject** buttons;
- `/today` shows what is due, drafts waiting and goals; `/drafts` lists drafts with buttons; `yes 12` / `no 12` also work.

Approving an email on the phone sends it at once from the person's mailbox when one is connected (or at its scheduled time); anything else is only marked approved, and the assistant sends it the next time it checks its drafts.

Once linked, the chat also gets a **morning brief** (default 08:00) and an **evening line** (default 21:00) in the person's own time zone; see "Working on its own".

Telegram rather than WhatsApp or Discord for the first channel: free, no business verification, works entirely by webhook on Vercel, and the bot can message anyone who pressed Start. WhatsApp (Meta verification, paid conversations) and Discord (a bot can only DM people it shares a server with) can be added behind the same `channel_*` functions.

Setup:

1. In Telegram, message @BotFather, send `/newbot`, pick a name and a username ending in `bot`.
2. Paste the token after `TELEGRAM_BOT_TOKEN=` in `.env.local` (never in a chat). `TELEGRAM_WEBHOOK_SECRET` is already there and matches Vercel.
3. `bun scripts/telegram-setup.ts https://aos-connect.vercel.app` sets the webhook and command menu and prints the bot username.
4. Add `TELEGRAM_BOT_TOKEN` and `NEXT_PUBLIC_TELEGRAM_BOT` (the username) to Vercel and redeploy. `SUPABASE_SECRET_KEY` and `TELEGRAM_WEBHOOK_SECRET` are already set.

Until the token is set, `/api/telegram` answers 503 and `/app` hides the Connect Telegram button.

**Live since 10 Nov 2026:** bot @aos_connect_bot (name "aos"), webhook `https://aos-connect.vercel.app/api/telegram` with only `message` and `callback_query` updates. Checked from Telegram: `/start` and `/today` from an unlinked chat answer with how to link (the second goes through the database with the secret key).

## Working on its own (the timer)

Phase B: aos does three things without the person opening their assistant. One route, `GET /api/cron`, does all of it; Vercel Cron calls it.

1. **Scheduled emails.** An approved email with a `send_after` goes out from the person's mailbox once that time has passed, through the same sealed send as a yes on `/app` (claimed once in the database, 50 a day, the touch cap). If the chat is linked, the person gets one line: sent, not sent because of the cap, refused or "may not have been sent". A send that certainly did not go out (login refused, server down) is tried again by the next runs, 3 tries in all; after that it waits for **Send now** on `/app`.
2. **Morning brief** on Telegram at the person's hour (default 08:00 in their time zone): what is due today (late ones first), today's calendar, goals that are behind or past their date, and each draft waiting for a yes (up to 5) with Approve and Reject. Plain code over the same agenda logic as `/today`; no model.
3. **Evening line** (default 21:00): one line with what got done today, how many drafts are waiting and how many messages went out.

The person switches each message on or off and picks its hour on `/app`, under **Your phone**, once Telegram is linked. Each message goes out at most once per person per local day; a message Telegram refused (for example the person blocked the bot) is tried again by the next runs, at most 3 times; one that timed out may have arrived and is not repeated.

**The per-recipient cap.** At most 2 emails to one address in 30 days, counting emails aos sent and emails an assistant sent itself and marked sent (the address is matched without case or display name). A third is not sent: the draft stays approved with the reason as its result, the timer leaves it alone, and **Send now** works again once the oldest of the two is 30 days old. The cap applies to everything aos sends itself; it cannot stop an assistant that sends with its own mail tool, but those sends still count toward the cap.

**Schedule and limits, plainly.** Vercel Hobby allows only cron jobs that run once a day, and runs each one anywhere within its hour. So `vercel.json` has 24 daily jobs on the same path, one for each UTC hour (Hobby allows 100 per project, and Vercel documents several schedules on one path). In practice the timer runs about once an hour, at an unpredictable minute:

- a scheduled email goes out up to about two hours after its `send_after`, not on the minute;
- a brief arrives within about two hours after the chosen hour. A morning brief is skipped for the day if no run comes within 4 hours of its hour, an evening line within 3 hours (so it never arrives at an odd time);
- Vercel says cron delivery is best effort and a run can be missed or repeated; every step above is safe to repeat.

For tighter timing: on Vercel Pro, replace the 24 entries with one `{ "path": "/api/cron", "schedule": "*/10 * * * *" }`. On Hobby, any free external scheduler can also call `GET https://aos-connect.vercel.app/api/cron` with the header `Authorization: Bearer <CRON_SECRET>` every 10 minutes; runs that overlap are harmless.

**Setting it up:** add `CRON_SECRET` (16 to 256 characters, letters and digits are safest, no spaces) to the Vercel production variables, push the two phase B migrations, and deploy. Vercel then sends the secret with every cron call. Without `CRON_SECRET` the route answers 503 and nothing runs; without `SUPABASE_SECRET_KEY` also 503; without `VAULT_KEY` nothing is sent but briefs still go; without `TELEGRAM_BOT_TOKEN` there are no briefs or pings but scheduled emails still go. The answer to a run holds counts only, never names, addresses or text.

**Scale, plainly:** one run sends at most 40 scheduled emails (one SMTP login each) and stops starting new work after 4 minutes; the rest wait for the next run. `brief_targets()` lists every linked person on each run and the due ones are worked out in code; that is fine for hundreds of people, not for many thousands.

## Run locally

`cp .env.example .env.local`, fill it in, then `npm run dev`. `npm run build` works without the variables; requests then answer that the server is not configured.

## Not in this first cut

- Email sign-in (Google only for now).
- An agent that works on its own. The timer only sends what the person already approved and reports their day; it writes nothing and decides nothing. Drafts on other channels (LinkedIn, WhatsApp, posts) still wait until the person talks to their assistant.
- A per-recipient cap for channels other than email: touches are keyed on an email address only.
- Minute-exact timing on Vercel Hobby (see "Working on its own").
- Brief contents written by a model, a weekly summary, or briefs on any channel other than Telegram.
