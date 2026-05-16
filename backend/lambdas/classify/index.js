// lambdas/classify/index.js
// POST /classify — takes video metadata, calls Bedrock, returns { educational: bool }

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { verifyToken } = require('../shared/auth');

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';

exports.handler = async (event) => {
  // Auth check
  const token = (event.headers?.Authorization || event.headers?.authorization || '').replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) return respond(401, { message: 'Unauthorized' });

  const body = JSON.parse(event.body || '{}');
  const { title = '', description = '', creator = '' } = body;

  if (!title) return respond(400, { message: 'title is required' });

  const prompt = `You are classifying YouTube videos to determine if they are educational or non-educational.

Video Title: ${title}
Creator: ${creator}
Description: ${description.slice(0, 400)}

What would you classify this as? educational or noneducational.
In terms of someone watching this video, do you think they are studying academically or doing something non-academic?

Respond with ONLY a JSON object in this exact format, nothing else:
{"classification": "educational"} or {"classification": "noneducational"}`;

  try {
    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 50,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const response = await bedrock.send(command);
    const result = JSON.parse(new TextDecoder().decode(response.body));
    const text = result.content?.[0]?.text || '{}';

    let classification = 'noneducational';
    try {
      const parsed = JSON.parse(text.trim());
      classification = parsed.classification || 'noneducational';
    } catch {
      // If Bedrock returns something unexpected, default to non-educational to be safe
      classification = text.toLowerCase().includes('educational') && !text.toLowerCase().includes('non')
        ? 'educational'
        : 'noneducational';
    }

    return respond(200, {
      educational: classification === 'educational',
      classification,
    });
  } catch (err) {
    console.error('Bedrock error:', err);
    return respond(500, { message: 'Classification failed', educational: true });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
