// lambdas/daily-reset/index.js
// Triggered by EventBridge Scheduler at midnight UTC
// Deletes all fg_daily_totals rows older than today to keep the table clean

const { DynamoDBClient, ScanCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');

const ddb = new DynamoDBClient({});
const DAILY_TOTALS_TABLE = process.env.DAILY_TOTALS_TABLE || 'fg_daily_totals';

exports.handler = async () => {
  const today = new Date().toISOString().slice(0, 10);

  let lastEvaluatedKey;
  let deleted = 0;

  do {
    const scan = await ddb.send(new ScanCommand({
      TableName: DAILY_TOTALS_TABLE,
      FilterExpression: '#d < :today',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':today': { S: today } },
      ProjectionExpression: 'userId, #d',
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    for (const item of scan.Items || []) {
      await ddb.send(new DeleteItemCommand({
        TableName: DAILY_TOTALS_TABLE,
        Key: { userId: item.userId, date: item.date },
      }));
      deleted++;
    }

    lastEvaluatedKey = scan.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Daily reset complete: deleted ${deleted} stale rows`);
  return { deleted };
};
