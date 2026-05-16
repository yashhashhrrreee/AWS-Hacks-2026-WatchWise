// lambdas/shared/auth.js
// Shared JWT verify + auth lambda handler

const jwt = require('jsonwebtoken');
const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const bcrypt = require('bcryptjs');

const ddb = new DynamoDBClient({});
const JWT_SECRET  = process.env.JWT_SECRET || 'changeme-use-env-var';
const USERS_TABLE = process.env.USERS_TABLE || 'fg_users';

function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Auth lambda handler (signup + login) — used by the auth lambda
async function authHandler(event) {
  const path = event.rawPath || event.path || '';
  const body = JSON.parse(event.body || '{}');
  const { email, password } = body;

  if (!email || !password) {
    return respond(400, { message: 'email and password required' });
  }

  // ── Signup ──────────────────────────────────────────────────────────────
  if (path.endsWith('/signup')) {
    const existing = await ddb.send(new GetItemCommand({
      TableName: USERS_TABLE,
      Key: { userId: { S: email.toLowerCase() } },
    }));

    if (existing.Item) return respond(409, { message: 'Account already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    await ddb.send(new PutItemCommand({
      TableName: USERS_TABLE,
      Item: {
        userId:           { S: email.toLowerCase() },
        email:            { S: email.toLowerCase() },
        passwordHash:     { S: passwordHash },
        dailyLimitSeconds:{ N: '7200' },
        createdAt:        { S: new Date().toISOString() },
      },
    }));

    const token = jwt.sign({ userId: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
    return respond(200, { token, userId: email.toLowerCase() });
  }

  // ── Login ───────────────────────────────────────────────────────────────
  if (path.endsWith('/login')) {
    const row = await ddb.send(new GetItemCommand({
      TableName: USERS_TABLE,
      Key: { userId: { S: email.toLowerCase() } },
    }));

    if (!row.Item) return respond(401, { message: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, row.Item.passwordHash.S);
    if (!valid) return respond(401, { message: 'Invalid credentials' });

    const token = jwt.sign({ userId: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
    return respond(200, { token, userId: email.toLowerCase() });
  }

  return respond(404, { message: 'Not found' });
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

module.exports = { verifyToken, authHandler };
