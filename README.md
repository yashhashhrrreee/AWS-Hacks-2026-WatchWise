# FocusGuard

Chrome extension that classifies YouTube videos as educational or non-educational using Amazon Bedrock, tracks non-academic watch time per user, and sends real-time alerts at 50% and 100% of a daily time limit via WebSocket.

---

## Architecture

```
Chrome Extension (content script)
  │
  ├─► [HTTP] POST /classify     → Lambda (classify)   → Bedrock Claude
  │                             ← { educational: bool }
  │
  ├─► [HTTP] POST /session      → Lambda (session-writer) → DynamoDB (sessions table)
  │                                                              │
  │                                                    DynamoDB Streams
  │                                                              │
  │                                                    Lambda (stream-processor)
  │                                                              │
  │                                          reads DynamoDB (users table for daily totals)
  │                                                              │
  │                                          if threshold crossed first time:
  │◄─────────────────────────────────────────── API Gateway WebSocket postToConnection
  │
  ├─► [WS]  $connect            → Lambda (ws-connect)  → DynamoDB (connections table)
  └─► [WS]  $disconnect         → Lambda (ws-disconnect) → DynamoDB (remove connection)
```

---

## DynamoDB Tables

### `fg_users`
| PK | Attribute | Notes |
|---|---|---|
| `userId` (S) | `email`, `passwordHash`, `dailyLimitSeconds`, `createdAt` | Default limit = 7200 (2hr) |

### `fg_sessions`
| PK | SK | Attributes |
|---|---|---|
| `userId` (S) | `sessionId` (S, uuid) | `videoId`, `videoTitle`, `videoCreator`, `durationSeconds`, `date` (YYYY-MM-DD), `classification` |

**Enable DynamoDB Streams** on `fg_sessions` → `NEW_IMAGE`

### `fg_daily_totals`
| PK | SK | Attributes |
|---|---|---|
| `userId` (S) | `date` (S, YYYY-MM-DD) | `totalSeconds` (N), `alert50Sent` (BOOL), `alert100Sent` (BOOL) |

### `fg_connections`
| PK | Attribute |
|---|---|
| `userId` (S) | `connectionId`, `ttl` (expire after 24hr) |

---

## Repo Structure

```
focusguard/
├── extension/
│   ├── manifest.json           # MV3 manifest
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js            # Login / signup / dashboard UI
│   ├── src/
│   │   ├── content.js          # YouTube video detection + timer
│   │   ├── background.js       # Service worker: session flush + WebSocket mgmt
│   │   └── auth.js             # Token storage helpers
│   └── icons/
├── backend/
│   ├── lambdas/
│   │   ├── classify/           # POST /classify → Bedrock
│   │   ├── session-writer/     # POST /session → DynamoDB
│   │   ├── stream-processor/   # DynamoDB Streams → threshold check → WS push
│   │   ├── ws-connect/         # WebSocket $connect
│   │   └── ws-disconnect/      # WebSocket $disconnect
│   └── infra/
│       └── template.yaml       # SAM / CloudFormation template
└── shared/
    └── constants.js            # Shared limit values, table names
```

---

## Step-by-Step Build Guide

### Phase 1 — AWS Infrastructure

**Step 1: DynamoDB Tables**
```
AWS Console → DynamoDB → Create table

1. fg_users          PK: userId (String)
2. fg_sessions       PK: userId (String)  SK: sessionId (String)
                     → Enable Streams: New image
3. fg_daily_totals   PK: userId (String)  SK: date (String)
4. fg_connections    PK: userId (String)
```

**Step 2: IAM Role for Lambdas**

Create role `focusguard-lambda-role` with:
- `AmazonDynamoDBFullAccess` (scope down later)
- `AmazonBedrockFullAccess`
- `AmazonAPIGatewayInvokeFullAccess` (for postToConnection)
- `AWSLambdaBasicExecutionRole`

**Step 3: Deploy Lambdas**

For each folder under `backend/lambdas/`:
```bash
cd backend/lambdas/<name>
zip -r function.zip .
aws lambda create-function \
  --function-name focusguard-<name> \
  --runtime nodejs20.x \
  --handler index.handler \
  --role arn:aws:iam::<account>:role/focusguard-lambda-role \
  --zip-file fileb://function.zip
```

**Step 4: API Gateway — HTTP API**

```
API Gateway → Create API → HTTP API
Add routes:
  POST /classify    → Lambda: focusguard-classify
  POST /session     → Lambda: focusguard-session-writer
  POST /auth/login  → Lambda: focusguard-classify (or separate auth lambda)
  POST /auth/signup → same

Enable CORS: origin *, headers Content-Type + Authorization
```

**Step 5: API Gateway — WebSocket API**

```
API Gateway → Create API → WebSocket API
Route selection: $request.body.action

Routes:
  $connect     → Lambda: focusguard-ws-connect
  $disconnect  → Lambda: focusguard-ws-disconnect

Deploy to stage: prod
Note the WebSocket URL: wss://<id>.execute-api.<region>.amazonaws.com/prod
```

**Step 6: DynamoDB Stream Trigger**

```
Lambda → focusguard-stream-processor → Add trigger
  Source: DynamoDB
  Table: fg_sessions
  Starting position: Latest
  Batch size: 10
```

---

### Phase 2 — Backend Lambda Code

Deploy the code from `backend/lambdas/`. Each lambda is documented inline.

Key env vars to set on each Lambda:
```
USERS_TABLE=fg_users
SESSIONS_TABLE=fg_sessions
DAILY_TOTALS_TABLE=fg_daily_totals
CONNECTIONS_TABLE=fg_connections
WS_ENDPOINT=https://<id>.execute-api.<region>.amazonaws.com/prod
BEDROCK_MODEL_ID=anthropic.claude-3-haiku-20240307-v1:0
JWT_SECRET=<your-secret>
```

---

### Phase 3 — Chrome Extension

**Step 1: Load the extension**
```
Chrome → chrome://extensions → Developer mode ON
→ Load unpacked → select focusguard/extension/
```

**Step 2: Set your API endpoints**

Edit `extension/src/background.js`:
```js
const API_BASE = 'https://<your-http-api>.execute-api.<region>.amazonaws.com';
const WS_URL   = 'wss://<your-ws-api>.execute-api.<region>.amazonaws.com/prod';
```

**Step 3: Test flow**
1. Click extension icon → Sign up with email + password
2. Open any YouTube video
3. Extension auto-classifies (check background console for result)
4. If non-educational: watch for 10+ seconds, pause → session is logged
5. Check DynamoDB `fg_sessions` and `fg_daily_totals` tables
6. Simulate threshold: manually set `totalSeconds` near 3600 (1hr) in `fg_daily_totals`, log another session → popup should appear

---

### Phase 4 — Auth

This repo uses a simple JWT flow (no Cognito dependency):
- Signup: hash password with bcrypt, store in `fg_users`, return JWT
- Login: verify hash, return JWT
- Extension stores JWT in `chrome.storage.local`
- Every API call sends `Authorization: Bearer <jwt>`
- Lambdas verify JWT with shared `JWT_SECRET`

To add Cognito later: swap the auth lambda for a Cognito User Pool + identity token — the rest of the architecture stays the same.

---

### Phase 5 — Alerts Flow Detail

```
stream-processor Lambda receives NEW_IMAGE from fg_sessions stream
  │
  ├─ if classification === 'educational' → skip
  │
  ├─ atomically add durationSeconds to fg_daily_totals[userId][today].totalSeconds
  │
  ├─ fetch user's dailyLimitSeconds from fg_users (default 7200)
  │
  ├─ compute percentage = totalSeconds / dailyLimitSeconds
  │
  ├─ if percentage >= 0.5 AND alert50Sent === false:
  │     set alert50Sent = true
  │     postToConnection(userId's connectionId, { alert: '50%' })
  │
  └─ if percentage >= 1.0 AND alert100Sent === false:
        set alert100Sent = true
        postToConnection(userId's connectionId, { alert: '100%' })
```

The `fg_daily_totals` row resets each new calendar day (checked by the `date` sort key).

---

## Local Development

```bash
# Test classify lambda locally
cd backend/lambdas/classify
npm install
node -e "
const {handler} = require('./index');
handler({ body: JSON.stringify({
  title: 'Calculus Full Course',
  description: 'Learn integrals and derivatives',
  creator: 'Professor Leonard'
}) }).then(r => console.log(r));
"
```

---

## Cost Estimate (light usage, us-east-1)

| Service | Estimate |
|---|---|
| DynamoDB (on-demand) | ~$0 at low volume |
| Lambda invocations | ~$0 at low volume |
| Bedrock Claude Haiku | ~$0.0008 per classification |
| API Gateway HTTP | $1 per million calls |
| API Gateway WebSocket | $0.80 per million messages |

Very cheap until you scale to thousands of users.
