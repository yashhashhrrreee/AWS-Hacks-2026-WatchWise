// lambdas/ws-disconnect/index.js
// Removes the connection record when user disconnects

const { DynamoDBClient, ScanCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');

const ddb = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'fg_connections';

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  // We need to find the userId for this connectionId
  // (DynamoDB PK is userId, not connectionId — a GSI is cleaner at scale)
  try {
    const scan = await ddb.send(new ScanCommand({
      TableName: CONNECTIONS_TABLE,
      FilterExpression: 'connectionId = :cid',
      ExpressionAttributeValues: { ':cid': { S: connectionId } },
      ProjectionExpression: 'userId',
    }));

    for (const item of scan.Items || []) {
      await ddb.send(new DeleteItemCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { userId: { S: item.userId.S } },
      }));
    }

    return { statusCode: 200, body: 'Disconnected' };
  } catch (err) {
    console.error('ws-disconnect error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};

// NOTE: For scale, add a GSI on fg_connections with connectionId as PK
// so ws-disconnect can do a direct GetItem instead of a Scan.
