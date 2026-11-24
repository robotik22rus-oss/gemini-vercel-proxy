// GET /v1/models — minimal OpenAI-compatible model list.

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gemini-3.5-flash';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ids = new Set([DEFAULT_MODEL, 'gemini-in-russia', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite']);
  res.status(200).json({
    object: 'list',
    data: [...ids].map((id) => ({
      id,
      object: 'model',
      owned_by: 'gemini-vercel-proxy',
      created: Math.floor(Date.now() / 1000),
    })),
  });
}
