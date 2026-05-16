// lambdas/ws-connect/index.js
// Called when the extension opens a WebSocket connection
// Stores connectionId → userId mapping in fg_connections

const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { verifyToken } = require('../shared/auth');

const ddb = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'fg_connections';

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  // Token is passed as a query string parameter: ?token=<jwt>
  const token = event.queryStringParameters?.token || '';
  const user = verifyToken(token);

  if (!user) {
    // Reject the connection
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours

  try {
    await ddb.send(new PutItemCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        userId:       { S: user.userId },
        connectionId: { S: connectionId },
        ttl:          { N: String(ttl) },
        connectedAt:  { S: new Date().toISOString() },
      },
    }));

    return { statusCode: 200, body: 'Connected' };
  } catch (err) {
    console.error('ws-connect error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
