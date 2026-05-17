// lambdas/set-limit/index.js
// PUT /limit — update personalised daily limits for entertainment and study goal
// Rules: both values must be 7200–21600 (2–6 hrs), 24hr cooldown between changes

const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { verifyToken } = require('../shared/auth');

const ddb = new DynamoDBClient({});
const USERS_TABLE = process.env.USERS_TABLE || 'fg_users';

const MIN_SEC = 7200;   // 2 hours
const MAX_SEC = 21600;  // 6 hours
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

exports.handler = async (event) => {
  const token = (event.headers?.Authorization || event.headers?.authorization || '').replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) return respond(401, { message: 'Unauthorized' });

  const body = JSON.parse(event.body || '{}');
  const { userId, limitSeconds, studyGoalSeconds } = body;

  if (user.userId !== userId) return respond(403, { message: 'Forbidden' });

  // Validate both fields
  if (
    typeof limitSeconds !== 'number' || limitSeconds < MIN_SEC || limitSeconds > MAX_SEC ||
    typeof studyGoalSeconds !== 'number' || studyGoalSeconds < MIN_SEC || studyGoalSeconds > MAX_SEC
  ) {
    return respond(400, {
      message: 'Both limits must be between 2 and 6 hours',
      minSeconds: MIN_SEC,
      maxSeconds: MAX_SEC,
    });
  }

  // Check cooldown
  const row = await ddb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: { userId: { S: userId } },
    ProjectionExpression: 'limitChangedAt',
  }));

  const lastChangedAt = row.Item?.limitChangedAt?.S;
  if (lastChangedAt) {
    const msSinceLast = Date.now() - new Date(lastChangedAt).getTime();
    if (msSinceLast < COOLDOWN_MS) {
      const nextAllowedAt = new Date(new Date(lastChangedAt).getTime() + COOLDOWN_MS).toISOString();
      return respond(429, {
        message: 'Limit was changed recently. Try again after the cooldown.',
        nextAllowedAt,
        cooldownRemainingMs: COOLDOWN_MS - msSinceLast,
      });
    }
  }

  const now = new Date().toISOString();
  await ddb.send(new UpdateItemCommand({
    TableName: USERS_TABLE,
    Key: { userId: { S: userId } },
    UpdateExpression: 'SET dailyLimitSeconds = :lim, studyGoalSeconds = :goal, limitChangedAt = :ts',
    ExpressionAttributeValues: {
      ':lim':  { N: String(limitSeconds) },
      ':goal': { N: String(studyGoalSeconds) },
      ':ts':   { S: now },
    },
  }));

  return respond(200, {
    limitSeconds,
    studyGoalSeconds,
    limitChangedAt: now,
  });
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
