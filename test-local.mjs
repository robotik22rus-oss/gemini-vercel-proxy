// Local smoke test: no network, no Gemini key. Stubs fetch and checks the
// OpenAI → Gemini → OpenAI mapping, including tool calls.
//
// Run:  node test-local.mjs

process.env.GEMINI_API_KEY = 'test-key';
process.env.DEFAULT_MODEL = 'gemini-3.1-flash-lite';

const { default: handler } = await import('./api/v1/chat/completions.js');

const captured = {};
globalThis.fetch = async (url, options) => {
  captured.url = String(url);
  captured.body = JSON.parse(options.body);
  if (String(url).includes('streamGenerateContent')) {
    const chunk = (data) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }));
        controller.enqueue(chunk({ candidates: [{ content: { parts: [{ text: 'lo' }] } }] }));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: 'Сейчас проверю погоду.' },
              { functionCall: { name: 'get_weather', args: { city: 'Москва' } } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(payload) {
      this.body = JSON.stringify(payload);
      return this;
    },
    write(chunk) {
      this.body += chunk;
      return true;
    },
    end() {},
  };
  return res;
}

const request = {
  model: 'gemini-in-russia',
  messages: [
    { role: 'system', content: 'Ты — ассистент.' },
    { role: 'user', content: 'Какая погода в Москве?' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Returns the weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
          additionalProperties: false,
        },
      },
    },
  ],
};

const res = fakeRes();
await handler({ method: 'POST', url: '/v1/chat/completions', headers: {}, body: request }, res);

const payload = JSON.parse(res.body);
const ok =
  res.statusCode === 200 &&
  payload.choices[0].message.tool_calls?.[0]?.function?.name === 'get_weather' &&
  captured.url.includes('gemini-3.1-flash-lite:generateContent') &&
  captured.body.tools[0].functionDeclarations[0].parameters.type === 'OBJECT' &&
  captured.body.systemInstruction.parts[0].text.includes('ассистент');

if (!ok) {
  console.error('FAILED', JSON.stringify({ status: res.statusCode, payload, captured }, null, 2));
  process.exit(1);
}

// streaming path
const res2 = fakeRes();
await handler(
  { method: 'POST', url: '/v1/chat/completions', headers: {}, body: { ...request, stream: true } },
  res2,
);
const streamed = res2.body.includes('"content":"Hel"') && res2.body.includes('[DONE]');
if (!streamed) {
  console.error('STREAM FAILED', res2.body);
  process.exit(1);
}

console.log('OK: mapping, tools and streaming verified offline');
