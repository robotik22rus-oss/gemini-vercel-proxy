// POST /v1/images/edits
// OpenAI-ish request: { model?, prompt, image: { data (base64), mimeType } }
// Response: { model, image: { data (base64), mimeType } }
//
// Uses Gemini image models (nano-banana family) to edit or restyle an image
// according to a text prompt. Same auth and env vars as the chat endpoint.

const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const IMAGE_MODELS = (process.env.IMAGE_MODELS || 'gemini-2.5-flash-image,gemini-3.1-flash-image,gemini-3-pro-image-preview')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function badRequest(res, message, status = 400) {
  res.status(status).json({ error: { message, type: 'proxy_error' } });
}

async function callImageModel(model, image, prompt) {
  const url = `${GEMINI_BASE}/models/${model}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: image.mimeType || 'image/jpeg', data: image.data } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY || '' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

function extractImage(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return { data: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png' };
    }
  }
  const text = parts.map((part) => part.text || '').join(' ').trim();
  throw new Error(text || 'model returned no image');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(204).end();
    return;
  }
  if (PROXY_TOKEN) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== PROXY_TOKEN) {
      badRequest(res, 'invalid proxy token', 401);
      return;
    }
  }
  if (!process.env.GEMINI_API_KEY) {
    badRequest(res, 'GEMINI_API_KEY is not configured', 500);
    return;
  }
  if (req.method !== 'POST') {
    badRequest(res, 'use POST', 405);
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const image = body.image || {};
  if (!image.data) {
    badRequest(res, 'image.data (base64) is required');
    return;
  }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) {
    badRequest(res, 'prompt is required');
    return;
  }

  const requested = String(body.model || '').trim();
  const candidates = requested && !/^(auto|default|image)$/i.test(requested)
    ? [requested, ...IMAGE_MODELS.filter((id) => id !== requested)]
    : IMAGE_MODELS;

  const errors = [];
  for (const model of candidates) {
    try {
      const payload = await callImageModel(model, image, prompt);
      const result = extractImage(payload);
      res.status(200).json({ model, image: result });
      return;
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
    }
  }
  badRequest(res, `image edit failed: ${errors.join(' | ')}`.slice(0, 900), 502);
}
