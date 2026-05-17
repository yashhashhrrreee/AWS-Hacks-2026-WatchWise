// lambdas/classify/index.js
// POST /classify — takes video metadata, calls Bedrock, returns { educational: bool }

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { verifyToken } = require('../shared/auth');

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

exports.handler = async (event) => {
  // Auth check
  const token = (event.headers?.Authorization || event.headers?.authorization || '').replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) return respond(401, { message: 'Unauthorized' });

  const body = JSON.parse(event.body || '{}');
  const { title = '', description = '', creator = '' } = body;

  if (!title) return respond(400, { message: 'title is required' });

  const prompt = `You classify YouTube videos as either "educational" or "noneducational" for a study-focus app.

A video is "educational" ONLY if it primarily teaches a specific academic, technical, or skill-based subject. Examples:
- University-style lectures (math, physics, history, philosophy, etc.)
- Programming tutorials, software engineering content
- Language learning lessons
- Science explainers (3Blue1Brown, Veritasium, Kurzgesagt, Khan Academy)
- Documentaries about real-world subjects
- Step-by-step how-to instruction with technical depth
- Test/exam prep content
- Professional skill tutorials (design, music theory, etc.)

EVERYTHING ELSE is "noneducational", including:
- Music videos, songs, concerts, music performances (Gangnam Style, Taylor Swift, etc.)
- Vlogs, daily life, lifestyle, "day in my life"
- Comedy, sketches, reaction videos, prank videos
- Gaming, gameplay, Let's Plays, esports
- Sports highlights, fitness without structured instruction
- News, politics, talk shows, podcasts (unless explicitly academic)
- Movie trailers, TV clips, anime, celebrity content
- Memes, shorts, viral clips, compilations
- Travel vlogs, food vlogs
- Marble races, ASMR, satisfying videos, animations for entertainment
- Product unboxings, hauls, casual reviews

Default to "noneducational" if uncertain. Music videos, marble races, and entertainment are ALWAYS "noneducational".

Video Title: ${title}
Creator: ${creator}
Description: ${description.slice(0, 400)}

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
