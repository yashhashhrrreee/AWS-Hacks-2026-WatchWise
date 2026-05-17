// lambdas/weekly-stats/index.js
// GET /weekly-stats?userId=<id> — returns last 7 days of edu + entertainment seconds

const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { verifyToken } = require('../shared/auth');

const ddb = new DynamoDBClient({});
const DAILY_TOTALS_TABLE = process.env.DAILY_TOTALS_TABLE || 'fg_daily_totals';

exports.handler = async (event) => {
  const token = (event.headers?.Authorization || event.headers?.authorization || '').replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) return respond(401, { message: 'Unauthorized' });

  const userId = event.queryStringParameters?.userId;
  if (!userId) return respond(400, { message: 'userId required' });
  if (user.userId !== userId) return respond(403, { message: 'Forbidden' });

  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const endDate = dateStr(today);
  const startDay = new Date(today);
  startDay.setDate(today.getDate() - 6);
  const startDate = dateStr(startDay);

  try {
    const res = await ddb.send(new QueryCommand({
      TableName: DAILY_TOTALS_TABLE,
      KeyConditionExpression: 'userId = :uid AND #d BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: {
        ':uid':   { S: userId },
        ':start': { S: startDate },
        ':end':   { S: endDate },
      },
    }));

    // Build a map of date → { eduSec, entSec }
    const byDate = {};
    for (const item of res.Items || []) {
      byDate[item.date.S] = {
        eduSec: parseInt(item.educationalSeconds?.N || '0', 10),
        entSec: parseInt(item.totalSeconds?.N        || '0', 10),
      };
    }

    // Fill all 7 days (zero for missing days)
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const ds = dateStr(d);
      days.push({
        date:   ds,
        eduSec: byDate[ds]?.eduSec || 0,
        entSec: byDate[ds]?.entSec || 0,
      });
    }

    return respond(200, { days });
  } catch (err) {
    console.error('weekly-stats error:', err);
    return respond(500, { message: 'Failed to load weekly stats' });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
