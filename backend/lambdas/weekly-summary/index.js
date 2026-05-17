// lambdas/weekly-summary/index.js
// Triggered every Sunday at 8am UTC via EventBridge
// Sends each user a weekly summary email: study vs entertainment hours, week-over-week progress

const { DynamoDBClient, ScanCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const ddb = new DynamoDBClient({});
const ses = new SESClient({ region: process.env.SES_REGION || 'us-east-1' });

const USERS_TABLE        = process.env.USERS_TABLE        || 'fg_users';
const DAILY_TOTALS_TABLE = process.env.DAILY_TOTALS_TABLE || 'fg_daily_totals';
const FROM_EMAIL         = process.env.SES_FROM_EMAIL     || 'noreply@watchwise.app';

// ── Date helpers ──────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekRange(daysBack, span = 7) {
  const end = new Date();
  end.setDate(end.getDate() - daysBack);
  const start = new Date(end);
  start.setDate(end.getDate() - (span - 1));
  return { start: dateStr(start), end: dateStr(end) };
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

async function getAllUsers() {
  const users = [];
  let lastKey;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: USERS_TABLE,
      ProjectionExpression: 'userId',
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items || []) users.push(item.userId.S);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return users;
}

async function getWeekTotals(userId, start, end) {
  const res = await ddb.send(new QueryCommand({
    TableName: DAILY_TOTALS_TABLE,
    KeyConditionExpression: 'userId = :uid AND #d BETWEEN :start AND :end',
    ExpressionAttributeNames: { '#d': 'date' },
    ExpressionAttributeValues: {
      ':uid':   { S: userId },
      ':start': { S: start },
      ':end':   { S: end },
    },
  }));

  let eduSec = 0;
  let entSec = 0;
  for (const item of res.Items || []) {
    eduSec += parseInt(item.educationalSeconds?.N || '0', 10);
    entSec += parseInt(item.totalSeconds?.N        || '0', 10);
  }
  return { eduSec, entSec };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function toHours(sec) {
  return (sec / 3600).toFixed(1);
}

function delta(curr, prev) {
  const diff = curr - prev;
  const h = Math.abs(diff / 3600).toFixed(1);
  if (diff > 0) return `<span style="color:#22c55e">▲ ${h}h</span>`;
  if (diff < 0) return `<span style="color:#f87171">▼ ${h}h</span>`;
  return `<span style="color:#888">— no change</span>`;
}

function buildEmail(email, thisWeek, lastWeek, isFirstWeek) {
  const name = email.split('@')[0];

  const comparisonBlock = isFirstWeek
    ? `<p style="color:#888;font-size:13px;margin-top:8px">This is your first week — check back next week for progress comparison!</p>`
    : `
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <tr style="color:#888;font-size:11px;text-transform:uppercase">
          <th align="left">Metric</th>
          <th align="right">This week</th>
          <th align="right">Last week</th>
          <th align="right">Change</th>
        </tr>
        <tr style="border-top:1px solid #2a2a3a;height:8px"><td colspan="4"></td></tr>
        <tr style="font-size:14px">
          <td style="padding:6px 0;color:#86efac">📚 Study</td>
          <td align="right">${toHours(thisWeek.eduSec)}h</td>
          <td align="right">${toHours(lastWeek.eduSec)}h</td>
          <td align="right">${delta(thisWeek.eduSec, lastWeek.eduSec)}</td>
        </tr>
        <tr style="font-size:14px">
          <td style="padding:6px 0;color:#f87171">🎬 Entertainment</td>
          <td align="right">${toHours(thisWeek.entSec)}h</td>
          <td align="right">${toHours(lastWeek.entSec)}h</td>
          <td align="right">${delta(lastWeek.entSec, thisWeek.entSec)}</td>
        </tr>
      </table>`;

  const studyRatio = thisWeek.eduSec + thisWeek.entSec > 0
    ? Math.round((thisWeek.eduSec / (thisWeek.eduSec + thisWeek.entSec)) * 100)
    : 0;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0">
  <div style="max-width:480px;margin:32px auto;background:#1a1a2e;border-radius:16px;overflow:hidden;border:1px solid #2a2a3a">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#7c3aed,#4f46e5);padding:24px 28px">
      <div style="font-size:20px;font-weight:700;color:#fff">WatchWise Weekly</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:2px">Your week in review</div>
    </div>

    <!-- Body -->
    <div style="padding:24px 28px">
      <p style="margin:0 0 4px;font-size:13px;color:#888">Hey ${name},</p>
      <p style="margin:0 0 20px;font-size:15px">Here's how your week went:</p>

      <!-- This week snapshot -->
      <div style="display:flex;gap:12px;margin-bottom:20px">
        <div style="flex:1;background:#0f0f1a;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#86efac">${toHours(thisWeek.eduSec)}h</div>
          <div style="font-size:11px;color:#888;margin-top:2px">studied</div>
        </div>
        <div style="flex:1;background:#0f0f1a;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#f87171">${toHours(thisWeek.entSec)}h</div>
          <div style="font-size:11px;color:#888;margin-top:2px">entertainment</div>
        </div>
        <div style="flex:1;background:#0f0f1a;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#a78bfa">${studyRatio}%</div>
          <div style="font-size:11px;color:#888;margin-top:2px">study ratio</div>
        </div>
      </div>

      <!-- Week comparison -->
      ${comparisonBlock}
    </div>

    <!-- Footer -->
    <div style="padding:16px 28px;border-top:1px solid #2a2a3a;font-size:11px;color:#555;text-align:center">
      WatchWise · Keep the streak going 🎯
    </div>
  </div>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async () => {
  const thisWeekRange = weekRange(0);   // today-6 → today
  const lastWeekRange = weekRange(7);   // today-13 → today-7

  const users = await getAllUsers();
  console.log(`Sending weekly summary to ${users.length} users`);

  let sent = 0;
  let failed = 0;

  for (const userId of users) {
    try {
      const [thisWeek, lastWeek] = await Promise.all([
        getWeekTotals(userId, thisWeekRange.start, thisWeekRange.end),
        getWeekTotals(userId, lastWeekRange.start, lastWeekRange.end),
      ]);

      const isFirstWeek = lastWeek.eduSec === 0 && lastWeek.entSec === 0;
      const html = buildEmail(userId, thisWeek, lastWeek, isFirstWeek);

      await ses.send(new SendEmailCommand({
        Source: FROM_EMAIL,
        Destination: { ToAddresses: [userId] },
        Message: {
          Subject: { Data: '📊 Your WatchWise Weekly Summary', Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' } },
        },
      }));

      sent++;
    } catch (err) {
      console.error(`Failed to send email to ${userId}:`, err.message);
      failed++;
    }
  }

  console.log(`Weekly summary done: ${sent} sent, ${failed} failed`);
  return { sent, failed };
};
