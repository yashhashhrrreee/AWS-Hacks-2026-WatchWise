// lambdas/stats/index.js
// GET /stats?userId=<id> — returns today's non-educational time + limit for the dashboard

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { verifyToken } = require('../shared/auth');

const ddb = new DynamoDBClient({});
const USERS_TABLE        = process.env.USERS_TABLE        || 'fg_users';
const DAILY_TOTALS_TABLE = process.env.DAILY_TOTALS_TABLE || 'fg_daily_totals';

exports.handler = async (event) => {
  const token = (event.headers?.Authorization || event.headers?.authorization || '').replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) return respond(401, { message: 'Unauthorized' });

  const userId = event.queryStringParameters?.userId;
  if (!userId) return respond(400, { message: 'userId required' });
  if (user.userId !== userId) return respond(403, { message: 'Forbidden' });

  const today = new Date().toISOString().slice(0, 10);

  try {
    const [userRow, totalRow] = await Promise.all([
      ddb.send(new GetItemCommand({
        TableName: USERS_TABLE,
        Key: { userId: { S: userId } },
        ProjectionExpression: 'dailyLimitSeconds, studyGoalSeconds, limitChangedAt, currentStreak, lastStudyDate',
      })),
      ddb.send(new GetItemCommand({
        TableName: DAILY_TOTALS_TABLE,
        Key: { userId: { S: userId }, date: { S: today } },
      })),
    ]);

    const limitSeconds        = parseInt(userRow.Item?.dailyLimitSeconds?.N || '7200', 10);
    const studyGoalSeconds    = parseInt(userRow.Item?.studyGoalSeconds?.N  || '7200', 10);
    const limitChangedAt      = userRow.Item?.limitChangedAt?.S || null;
    const totalSeconds        = parseInt(totalRow.Item?.totalSeconds?.N || '0', 10);
    const educationalSeconds  = parseInt(totalRow.Item?.educationalSeconds?.N || '0', 10);

    // Compute effective streak and grace period
    const rawStreak     = parseInt(userRow.Item?.currentStreak?.N || '0', 10);
    const lastStudyDate = userRow.Item?.lastStudyDate?.S || null;

    const yesterday  = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr  = yesterday.toISOString().slice(0, 10);
    const twoDaysAgo = new Date(today); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10);

    let currentStreak = 0;
    let streakAtRisk  = false;
    let graceExpiresAt = null;

    if (lastStudyDate === today || lastStudyDate === yesterdayStr) {
      currentStreak = rawStreak;
    } else if (lastStudyDate === twoDaysAgoStr) {
      const midnightToday = new Date(today + 'T00:00:00.000Z').getTime();
      const graceEnd = new Date(midnightToday + 12 * 3600 * 1000);
      if (new Date() < graceEnd) {
        currentStreak  = rawStreak;
        streakAtRisk   = true;
        graceExpiresAt = graceEnd.toISOString();
      }
      // else grace expired → streak stays 0
    }

    return respond(200, {
      totalSeconds, limitSeconds, studyGoalSeconds, limitChangedAt,
      educationalSeconds, date: today,
      currentStreak, streakAtRisk, graceExpiresAt,
    });
  } catch (err) {
    console.error('stats error:', err);
    return respond(500, { message: 'Failed to load stats' });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
