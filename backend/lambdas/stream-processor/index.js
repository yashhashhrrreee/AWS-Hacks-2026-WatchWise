// lambdas/stream-processor/index.js
// Triggered by DynamoDB Streams on fg_sessions table
// Aggregates daily non-edu time, checks 50% / 100% thresholds, pushes via WebSocket

const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const ddb = new DynamoDBClient({});
const DAILY_TOTALS_TABLE  = process.env.DAILY_TOTALS_TABLE  || 'fg_daily_totals';
const CONNECTIONS_TABLE   = process.env.CONNECTIONS_TABLE   || 'fg_connections';
const USERS_TABLE         = process.env.USERS_TABLE         || 'fg_users';

// Set this env var to your WebSocket API endpoint (https:// NOT wss://)
// e.g. https://abc123.execute-api.us-east-1.amazonaws.com/prod
const WS_ENDPOINT = process.env.WS_ENDPOINT;

exports.handler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT') continue;

    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;

    const userId          = newImage.userId?.S;
    const classification  = newImage.classification?.S;
    const durationSeconds = parseInt(newImage.durationSeconds?.N || '0', 10);
    const date            = newImage.date?.S;

    if (!userId || !date || durationSeconds < 1) continue;

    // Educational sessions: only accumulate educationalSeconds, no alert checks
    if (classification === 'educational') {
      try {
        await ddb.send(new UpdateItemCommand({
          TableName: DAILY_TOTALS_TABLE,
          Key: { userId: { S: userId }, date: { S: date } },
          UpdateExpression: 'ADD educationalSeconds :dur',
          ExpressionAttributeValues: { ':dur': { N: String(durationSeconds) } },
        }));
      } catch (err) {
        console.error(`Error updating edu seconds for user ${userId}:`, err);
      }
      continue;
    }

    if (classification !== 'noneducational') continue;

    try {
      // 1. Atomically update daily total and get new values
      const updated = await ddb.send(new UpdateItemCommand({
        TableName: DAILY_TOTALS_TABLE,
        Key: {
          userId: { S: userId },
          date:   { S: date },
        },
        UpdateExpression: 'ADD totalSeconds :dur',
        ExpressionAttributeValues: { ':dur': { N: String(durationSeconds) } },
        ReturnValues: 'ALL_NEW',
      }));

      const attrs = updated.Attributes;
      const totalSeconds = parseInt(attrs?.totalSeconds?.N || '0', 10);
      const alert50Sent  = attrs?.alert50Sent?.BOOL === true;
      const alert100Sent = attrs?.alert100Sent?.BOOL === true;

      // 2. Get user's daily limit
      const userRow = await ddb.send(new GetItemCommand({
        TableName: USERS_TABLE,
        Key: { userId: { S: userId } },
        ProjectionExpression: 'dailyLimitSeconds',
      }));
      const limitSeconds = parseInt(userRow.Item?.dailyLimitSeconds?.N || '7200', 10);

      const pct = totalSeconds / limitSeconds;

      // 3. Check thresholds
      let alertType = null;

      if (pct >= 1.0 && !alert100Sent) {
        alertType = '100%';
        await markAlertSent(userId, date, '100');
      } else if (pct >= 0.5 && !alert50Sent) {
        alertType = '50%';
        await markAlertSent(userId, date, '50');
      }

      if (alertType) {
        await pushAlert(userId, alertType, totalSeconds, limitSeconds);
      }

    } catch (err) {
      console.error(`Error processing record for user ${userId}:`, err);
    }
  }
};

async function markAlertSent(userId, date, level) {
  const attr = level === '100' ? 'alert100Sent' : 'alert50Sent';
  await ddb.send(new UpdateItemCommand({
    TableName: DAILY_TOTALS_TABLE,
    Key: { userId: { S: userId }, date: { S: date } },
    UpdateExpression: `SET ${attr} = :t`,
    ExpressionAttributeValues: { ':t': { BOOL: true } },
  }));
}

async function pushAlert(userId, alertType, totalSeconds, limitSeconds) {
  // Look up WebSocket connectionId for this user
  const connRow = await ddb.send(new GetItemCommand({
    TableName: CONNECTIONS_TABLE,
    Key: { userId: { S: userId } },
  }));

  const connectionId = connRow.Item?.connectionId?.S;
  if (!connectionId) {
    console.log(`No active WS connection for user ${userId}, alert not sent`);
    return;
  }

  if (!WS_ENDPOINT) {
    console.warn('WS_ENDPOINT env var not set');
    return;
  }

  const apiGw = new ApiGatewayManagementApiClient({ endpoint: WS_ENDPOINT });

  const payload = JSON.stringify({
    alert: alertType,
    totalSeconds,
    limitSeconds,
    message: alertType === '50%'
      ? `You've used ${Math.round(totalSeconds / 60)} of ${Math.round(limitSeconds / 60)} minutes of non-academic time today.`
      : `You've hit your ${Math.round(limitSeconds / 60)}-minute daily limit for non-academic videos.`,
  });

  try {
    await apiGw.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(payload),
    }));
    console.log(`Alert ${alertType} sent to user ${userId}`);
  } catch (err) {
    if (err.statusCode === 410) {
      // Connection is stale — clean it up
      console.log(`Stale connection for ${userId}, removing`);
      // Optionally delete from fg_connections here
    } else {
      console.error('postToConnection error:', err);
    }
  }
}
