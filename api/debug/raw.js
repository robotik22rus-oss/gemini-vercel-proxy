// Debug: POST /api/debug/raw?model=<id> with a Gemini request body and the raw
// upstream answer comes back unchanged. Protected by PROXY_TOKEN.

const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

export default async function handler(req, res) {
  const token = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  if (process.env.PROXY_TOKEN && token !== process.env.PROXY_TOKEN) {
    res.status(401).json({ error: { message: 'invalid proxy token' } });
    return;
  }
  const url = new URL(req.url, 'https://local');
  const model = url.searchParams.get('model') || process.env.DEFAULT_MODEL || 'gemini-3.5-flash';
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  try {
    const upstream = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY || '' },
      body,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.send(text);
  } catch (error) {
    res.status(502).json({ error: { message: String(error?.message || error) } });
  }
}
