# WatchWise

A Chrome extension that uses AI to classify YouTube videos as educational or entertainment, tracks your daily watch time, enforces personal limits, and helps you build consistent study habits.

---

## What It Does

WatchWise sits silently in your browser while you watch YouTube. Every video you open is classified by Claude (via Amazon Bedrock) — educational content like lectures, tutorials, and documentaries are tracked separately from entertainment. You set a daily entertainment limit (2–6 hours). When you hit 50% you get a warning. When you hit 100% you can optionally trigger a full-screen block overlay that prevents further watching until midnight.

**Core features:**

- AI video classification (Claude Haiku via Amazon Bedrock)
- Separate tracking for educational vs entertainment time
- Personalised daily entertainment limit and study goal (2–6 hr range, 24hr change cooldown)
- Real-time alerts at 50% and 100% via WebSocket push
- Optional hard block overlay at 100% — non-dismissible, pauses video, resets at midnight
- Study streak tracking with 12-hour grace period to revive a broken streak
- Weekly summary email every Sunday (study hours, entertainment hours, week-over-week diff)
- Daily cleanup of stale DynamoDB rows at midnight UTC

---

## Architecture

```
YouTube Tab
  └── content.js          detects video, runs timers, flushes sessions
        │
        ▼
  background.js (MV3 service worker)
        ├── POST /classify ──────────────► Lambda → Amazon Bedrock (Claude Haiku)
        ├── POST /session ───────────────► Lambda → DynamoDB fg_sessions
        └── WebSocket (wss://) ──────────► API Gateway WebSocket API
                                                  │
DynamoDB Streams (fg_sessions)                    │
  └── stream-processor Lambda                     │
        ├── ADD totalSeconds / educationalSeconds  │
        ├── check 50% / 100% thresholds            │
        ├── update streak in fg_users              │
        └── push alert ──────────────────────────►┘

EventBridge (cron)
  ├── midnight UTC    → daily-reset Lambda    (delete stale fg_daily_totals rows)
  └── Sunday 8am UTC → weekly-summary Lambda  (SES email to all users)
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Browser extension | Chrome MV3, vanilla JS |
| Classification AI | Amazon Bedrock — Claude Haiku (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) |
| Backend compute | AWS Lambda (Node.js 20.x) |
| API | AWS API Gateway — HTTP API + WebSocket API |
| Database | Amazon DynamoDB (4 tables, on-demand billing) |
| Event streaming | DynamoDB Streams → Lambda |
| Scheduling | Amazon EventBridge Scheduler |
| Email | Amazon SES |
| IaC | AWS SAM (CloudFormation transform) |
| Auth | JWT (30-day expiry) + bcrypt password hashing |

---

## Project Structure

```
├── extension/
│   ├── manifest.json
│   ├── icons/
│   ├── popup/
│   │   ├── popup.html        dashboard UI
│   │   ├── popup.css
│   │   └── popup.js          auth, stats, limit settings, block mode
│   └── src/
│       ├── background.js     service worker: classify, session writes, WebSocket
│       └── content.js        video detection, timers, block overlay
└── backend/
    ├── lambdas/
    │   ├── auth/             POST /auth/login  POST /auth/signup
    │   ├── classify/         POST /classify
    │   ├── session-writer/   POST /session
    │   ├── stats/            GET  /stats
    │   ├── set-limit/        PUT  /limit
    │   ├── weekly-stats/     GET  /weekly-stats
    │   ├── stream-processor/ DynamoDB Streams trigger
    │   ├── daily-reset/      EventBridge midnight cron
    │   ├── weekly-summary/   EventBridge Sunday cron
    │   ├── ws-connect/       WebSocket $connect
    │   ├── ws-disconnect/    WebSocket $disconnect
    │   └── shared/
    │       └── auth.js       JWT verify + auth handler
    └── infra/
        └── template.yaml     SAM template (all resources)
```

---

## DynamoDB Tables

| Table | PK | SK | Key Attributes |
|-------|----|----|----------------|
| `fg_users` | `userId` (S) | — | `email`, `passwordHash`, `dailyLimitSeconds`, `studyGoalSeconds`, `currentStreak`, `lastStudyDate`, `limitChangedAt` |
| `fg_sessions` | `userId` (S) | `sessionId` (S) | `videoId`, `videoTitle`, `videoCreator`, `durationSeconds`, `classification`, `date` — **Streams: NEW_IMAGE** |
| `fg_daily_totals` | `userId` (S) | `date` (S) | `totalSeconds`, `educationalSeconds`, `alert50Sent`, `alert100Sent` |
| `fg_connections` | `userId` (S) | — | `connectionId`, `ttl` (24hr auto-expire) |

---

## Prerequisites

- AWS account with Bedrock access (Claude Haiku model enabled in your region)
- AWS CLI configured (`aws configure`)
- AWS SAM CLI installed — [install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Node.js 20+
- SES verified sender email (for weekly summary emails)
- Google Chrome

---

## Build & Deploy

### 1. Deploy the backend

```bash
cd backend/lambdas && npm install && cd ..

# First-time deploy (interactive setup)
sam build && sam deploy --guided
```

When prompted:
- **Stack name:** `focusguard`
- **Region:** a region with Bedrock Claude Haiku available (e.g. `us-east-1`)
- **Confirm changesets:** Yes

Note the outputs after deploy:

```
HttpApiUrl   = https://<id>.execute-api.<region>.amazonaws.com
WebSocketUrl = wss://<id>.execute-api.<region>.amazonaws.com/prod
```

Subsequent deploys after code changes:

```bash
sam build && sam deploy
```

### 2. Point the extension at your endpoints

Edit `extension/src/background.js` — update the two constants at the top:

```js
const API_BASE = 'https://<your-http-api-id>.execute-api.<region>.amazonaws.com';
const WS_URL   = 'wss://<your-ws-api-id>.execute-api.<region>.amazonaws.com/prod';
```

### 3. Configure the weekly email sender

In `backend/infra/template.yaml` find `WeeklySummaryFunction` and set:

```yaml
SES_FROM_EMAIL: noreply@yourdomain.com
```

Verify that address/domain in the AWS Console under **SES → Verified Identities**.

> If your SES account is in sandbox mode, you also need to verify each recipient address before they can receive emails. Request production access to lift this restriction.

### 4. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder

The FocusGuard icon appears in your toolbar. Click it to sign up and start tracking.

---

## Environment Variables

Set automatically by SAM via `template.yaml`. Override as needed:

| Variable | Default | Notes |
|----------|---------|-------|
| `JWT_SECRET` | `watchwise-super-secret-jwt-key-2026` | Change before production |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Must be enabled in your AWS region |
| `SES_FROM_EMAIL` | set in template | Must be SES-verified |
| `SES_REGION` | inherits deploy region | Override if SES is in a different region |

---

## How It Works

### Video classification
When you navigate to a YouTube video, `content.js` waits 2 seconds for the DOM to populate then extracts title, creator, and description. `background.js` POSTs this to `/classify`, which sends a structured prompt to Claude Haiku on Bedrock. Educational content starts an edu timer; entertainment starts the limit timer.

### Session flush
When you pause, end, or navigate away, `content.js` flushes accumulated seconds to `/session` with the correct classification. The session is written to `fg_sessions`.

### Real-time alerts
The DynamoDB Stream on `fg_sessions` triggers `stream-processor`. It atomically increments `totalSeconds` or `educationalSeconds` in `fg_daily_totals`, checks your limit, and pushes a WebSocket message at 50% and 100%. The background service worker receives this and shows the warning modal or triggers the block overlay.

### Block mode
At the 50% warning you can enable Block Mode. If enabled and you hit 100%, `background.js` persists `fg_blocked_date = today` and broadcasts `SHOW_BLOCK_OVERLAY` to all open YouTube tabs. `content.js` injects a full-screen overlay, pauses the video, and intercepts every `play` event to prevent resuming. Persists across SPA navigations and new tabs until midnight.

### Study streak
Every educational session updates `currentStreak` and `lastStudyDate` in `fg_users` via `stream-processor`. Miss a day? You have a 12-hour grace window from midnight UTC on the following day to study and revive your streak before it resets.

### Personalised limits
Users can set entertainment limit and study goal between 2 and 6 hours via sliders in the popup. A 24-hour cooldown prevents changes more than once per day.

### Weekly email
Every Sunday at 8am UTC, `weekly-summary` scans all users, queries their last 7 and previous 7 days, and sends a styled HTML email via SES with study hours, entertainment hours, study ratio, and week-over-week deltas.

---

## Cost Estimate

| Service | Est. cost |
|---------|-----------|
| Bedrock Claude Haiku | ~$0.0008 per video classification |
| Lambda | Free tier covers typical personal use |
| DynamoDB | ~$0 on-demand at low volume |
| API Gateway | ~$1 per million API calls |
| SES | $0.10 per 1,000 emails |

---

## Known Limitations

- Classification accuracy depends on video metadata quality. Shorts and videos with vague titles may be misclassified — Claude defaults to non-educational when uncertain.
- The WebSocket connection drops when the MV3 service worker sleeps. It reconnects automatically within 5 seconds on the next event.
- Block overlay can be bypassed by disabling the extension. This is intentional — the tool is a commitment device, not a parental control.
- SES sandbox mode limits sending to verified addresses only. Request production access for real user emails.
