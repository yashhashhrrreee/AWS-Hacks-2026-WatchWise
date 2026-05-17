// lambdas/session-writer/index.js
// POST /session — writes a watch session to DynamoDB fg_sessions

const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { verifyToken } = require('../shared/auth');

const ddb = new DynamoDBClient({});
const SESSIONS_TABLE = process.env.SESSIONS_TABLE || 'fg_sessions';

exports.handler = async (event) => {
  const token = (event.headers?.Authorization || event.headers?.authorization || '').replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) return respond(401, { message: 'Unauthorized' });

  const body = JSON.parse(event.body || '{}');
  const { videoId, videoTitle, videoCreator, durationSeconds, userId, classification } = body;

  // Validate that the token user matches the submitted userId
  if (user.userId !== userId) return respond(403, { message: 'Forbidden' });

  if (!videoId || !durationSeconds || durationSeconds < 1) {
    return respond(400, { message: 'Invalid session data' });
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const sessionId = uuidv4();

  try {
    await ddb.send(new PutItemCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        userId:          { S: userId },
        sessionId:       { S: sessionId },
        videoId:         { S: videoId || 'unknown' },
        videoTitle:      { S: videoTitle || '' },
        videoCreator:    { S: videoCreator || '' },
        durationSeconds: { N: String(Math.round(durationSeconds)) },
        classification:  { S: classification === 'educational' ? 'educational' : 'noneducational' },
        date:            { S: today },
        createdAt:       { S: new Date().toISOString() },
      },
    }));

    return respond(200, { sessionId });
  } catch (err) {
    console.error('DynamoDB write error:', err);
    return respond(500, { message: 'Failed to save session' });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
