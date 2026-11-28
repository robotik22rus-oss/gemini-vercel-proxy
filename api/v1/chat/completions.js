// OpenAI-compatible endpoint backed by the Gemini API.
//
// POST /v1/chat/completions  — chat, streaming (SSE) and OpenAI-style tool calls
// GET  /v1/models            — the short model list
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   GEMINI_API_KEY   required, key from https://aistudio.google.com/apikey
//   DEFAULT_MODEL    optional, default "gemini-3.1-flash-lite"
//   PROXY_TOKEN      optional; when set, every request needs
//                    "Authorization: Bearer <PROXY_TOKEN>"
//   GEMINI_BASE_URL  optional, default https://generativelanguage.googleapis.com/v1beta

const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
function cleanModelId(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '');
  return cleaned || fallback;
}

const DEFAULT_MODEL = cleanModelId(process.env.DEFAULT_MODEL, 'gemini-3.6-flash');
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const ALIASES = new Set(['gemini-in-russia', 'gemini-ru', 'gemini']);
const FALLBACK_MODELS = (process.env.FALLBACK_MODELS || 'gemini-3.5-flash,gemini-3.1-flash-lite')
  .split(',')
  .map((item) => cleanModelId(item, ''))
  .filter(Boolean);
const RETRYABLE = /(50[0234]|429|location is not supported|attempt timeout)/i;
// Gemini 3 requires the thought signature of every functionCall to be sent back
// unchanged. OpenAI's schema has nowhere to put it, so it travels inside the
// tool_call id: "fc_<random>_<signature>".
const SIG_RE = /^fc_[a-z0-9]+_(.+)$/;

function toolCallId(signature) {
  if (!signature) return `call_${Math.random().toString(36).slice(2, 10)}`;
  return `fc_${Math.random().toString(36).slice(2, 8)}_${signature}`;
}

function signatureOf(id) {
  const match = SIG_RE.exec(String(id || ''));
  return match ? match[1] : null;
}

const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'minItems', 'maxItems', 'minimum', 'maximum', 'propertyOrdering',
]);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return '';
}

function dataUrlPart(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2].replace(/\s+/g, '') } };
}

async function imagePart(url) {
  const raw = String(url || '');
  if (!raw) return null;
  const inline = dataUrlPart(raw);
  if (inline) return inline;
  if (!/^https?:/i.test(raw)) return null;
  try {
    const response = await fetch(raw);
    if (!response.ok) return null;
    const mime = (response.headers.get('content-type') || 'image/png').split(';')[0];
    const buffer = Buffer.from(await response.arrayBuffer());
    return { inlineData: { mimeType: mime, data: buffer.toString('base64') } };
  } catch {
    return null;
  }
}

async function partsOf(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item) parts.push({ text: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string' && item.text) {
      parts.push({ text: item.text });
      continue;
    }
    const url = item.image_url?.url || (typeof item.image_url === 'string' ? item.image_url : '');
    if (url) {
      const part = await imagePart(url);
      if (part) parts.push(part);
    }
  }
  return parts;
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '{}');
  } catch {
    return { value: String(value ?? '') };
  }
}

function sanitizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [prop, sub] of Object.entries(value)) out.properties[prop] = sanitizeSchema(sub);
    } else if (key === 'items') {
      out.items = sanitizeSchema(value);
    } else if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
    } else {
      out[key] = sanitizeSchema(value);
    }
  }
  return out;
}

function resolveModel(modelId) {
  const id = String(modelId || '').trim();
  if (!id || ALIASES.has(id)) return DEFAULT_MODEL;
  return id;
}

async function toGeminiRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts = [];
  const contents = [];
  let pendingToolNames = new Map();

  for (const message of messages) {
    const role = message?.role || 'user';
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content);
      if (text) systemParts.push({ text });
      continue;
    }
    if (role === 'tool') {
      const name = message.name || pendingToolNames.get(message.tool_call_id) || 'tool';
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: safeJson(message.content) } }],
      });
      continue;
    }
    if (role === 'assistant') {
      const parts = await partsOf(message.content);
      for (const call of message.tool_calls || []) {
        const name = call?.function?.name || 'tool';
        if (call?.id) pendingToolNames.set(call.id, name);
        const part = { functionCall: { name, args: safeJson(call?.function?.arguments) } };
        const signature = signatureOf(call?.id);
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    const parts = await partsOf(message.content);
    if (parts.length) contents.push({ role: 'user', parts });
  }

  const request = { contents };
  if (systemParts.length) request.systemInstruction = { parts: systemParts };

  const declarations = [];
  for (const tool of body.tools || []) {
    if (tool?.type !== 'function' || !tool.function?.name) continue;
    declarations.push({
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: sanitizeSchema(tool.function.parameters || { type: 'object', properties: {} }),
    });
  }
  if (declarations.length) request.tools = [{ functionDeclarations: declarations }];

  const config = {};
  const effort = String(body.reasoning_effort ?? '').toLowerCase();
  // Clients that do not send reasoning_effort (mobile apps) would inherit the
  // model's default thinking, which can exceed Vercel's 60 s function limit.
  // Treat "not specified" as thinking off; explicit low/medium/high keep the
  // provider default.
  if (effort === '' || effort === 'none' || effort === 'off' || body.reasoning_effort === 0) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  if (Number.isFinite(body.max_tokens)) config.maxOutputTokens = body.max_tokens;
  if (Number.isFinite(body.temperature)) config.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) config.topP = body.top_p;
  if (Object.keys(config).length) request.generationConfig = config;

  return request;
}

function fromGeminiResponse(data, modelId) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('');
  const toolCalls = [];
  for (const part of parts) {
    if (!part.functionCall) continue;
    toolCalls.push({
      id: toolCallId(part.thoughtSignature),
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args || {}),
      },
    });
  }
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = data?.usageMetadata || {};
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokenCount || 0,
      completion_tokens: usage.candidatesTokenCount || 0,
      total_tokens: usage.totalTokenCount || 0,
    },
  };
}

function badRequest(res, message, status = 400) {
  res.status(status).json({ error: { message, type: 'proxy_error' } });
}

const ATTEMPT_TIMEOUT_MS = Number(process.env.ATTEMPT_TIMEOUT_MS || 18000);

async function callGemini(path, request, stream) {
  const url = `${GEMINI_BASE}/models/${path}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY || '',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw new Error('attempt timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status}: ${detail.slice(0, 500)}`);
  }
  return response;
}

async function streamToOpenAI(geminiResponse, res, modelId) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (delta, finish = null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  };

  send({ role: 'assistant' });
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = [];

  for await (const chunk of geminiResponse.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      for (const part of parsed?.candidates?.[0]?.content?.parts || []) {
        if (part.text) send({ content: part.text });
        if (part.functionCall) {
          toolCalls.push({
            id: toolCallId(part.thoughtSignature),
            type: 'function',
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
          });
        }
      }
    }
  }

  if (toolCalls.length) {
    send({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }, 'tool_calls');
  } else {
    send({}, 'stop');
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function callWithFallback(model, request, stream) {
  const candidates = [model, ...FALLBACK_MODELS.filter((id) => id !== model)];
  let lastError;
  for (const candidate of candidates) {
    try {
      return { model: candidate, response: await callGemini(candidate, request, stream) };
    } catch (error) {
      lastError = error;
      if (!RETRYABLE.test(String(error?.message || ''))) throw error;
    }
  }
  throw lastError;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
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

  const path = (req.url || '').split('?')[0];
  try {
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.status(200).json({
        object: 'list',
        data: [{ id: 'gemini-in-russia', object: 'model', owned_by: 'gemini-vercel-proxy' }],
      });
      return;
    }
    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      badRequest(res, 'unknown route', 404);
      return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const model = resolveModel(body.model);
    const request = await toGeminiRequest(body);
    if (!request.contents.length) {
      badRequest(res, 'messages are empty');
      return;
    }

    const upstreamResult = await callWithFallback(model, request, Boolean(body.stream));
    const usedModel = upstreamResult.model;
    const upstream = upstreamResult.response;
    res.setHeader('x-gemini-model', usedModel);
    res.setHeader('access-control-expose-headers', 'x-gemini-model');
    if (body.stream) {
      await streamToOpenAI(upstream, res, usedModel);
      return;
    }
    const data = await upstream.json();
    const payload = fromGeminiResponse(data, usedModel);
    payload.model_used = usedModel;
    res.status(200).json(payload);
  } catch (error) {
    badRequest(res, String(error?.message || error), 502);
  }
}
