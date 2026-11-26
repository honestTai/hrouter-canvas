import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, type Site } from '../src/config.ts';
import { generateImage } from '../src/providers.ts';

const site: Site = {
  id: 'test', name: 'Test', baseUrl: 'https://example.invalid',
  apiKey: 'sk-private-test', protocol: 'openai', models: ['gpt-image-2'],
};
const input = { model: 'gpt-image-2', prompt: 'test', references: [] };

for (const [name, error] of [
  ['response timeout', new DOMException('sensitive URL', 'TimeoutError')],
  ['body timeout', new TypeError('sensitive URL', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } })],
  ['unknown read failure', new Error('sk-private-test https://example.invalid/private')],
] as const) {
  test(`${name} is explained without leaking exception details`, async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(
      new ReadableStream({ start(controller) { controller.error(error); } }),
    ));
    await assert.rejects(generateImage(site, input, new AbortController().signal), (failure: unknown) => {
      assert.ok(failure instanceof HttpError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /读取生图接口响应/);
      assert.match(failure.message, name === 'unknown read failure' ? /数据读取失败/ : /超时/);
      assert.match(failure.message, /未自动重试/);
      assert.doesNotMatch(failure.message, /sk-private-test|sensitive|example\.invalid/);
      return true;
    });
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

test('a shutdown during response reading is reported as cancellation', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(stream) {
      controller.abort();
      stream.error(new DOMException('Aborted', 'AbortError'));
    },
  })));
  await assert.rejects(generateImage(site, input, controller.signal), (failure: unknown) => {
    assert.ok(failure instanceof HttpError);
    assert.equal(failure.status, 499);
    assert.equal(failure.message, '已取消');
    return true;
  });
});

test('animated GIF sends output_format and frame params, only for gpt-image-2.6 text-to-image', async (t) => {
  const gif = Buffer.from([71, 73, 70, 56, 57, 97, 2, 0, 3, 0, 0, 0, 0, 0x3b]);
  let sent: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
    sent = JSON.parse(init.body);
    return Response.json({ data: [{ b64_json: gif.toString('base64') }] });
  });
  const animation = { frameCount: 6, frameDurationMs: 150 };
  const result = await generateImage(site, { model: 'gpt-image-2.6-flare', prompt: 'wave', references: [], animation }, new AbortController().signal);
  assert.equal(sent.output_format, 'gif');
  assert.equal(sent.frame_count, 6);
  assert.equal(sent.frame_duration_ms, 150);
  assert.deepEqual([result.mime, result.width, result.height], ['image/gif', 2, 3]);
  await assert.rejects(generateImage(site, { model: 'gpt-image-2', prompt: 'x', references: [], animation }, new AbortController().signal), /gpt-image-2\.6/);
  await assert.rejects(
    generateImage(site, { model: 'gpt-image-2.6-flare', prompt: 'x', references: [{ bytes: new Uint8Array(1), mime: 'image/png' }], animation }, new AbortController().signal),
    /不能带参考图/,
  );
  assert.equal('stream' in sent, false);
});

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const WEBP_2X2 = Buffer.from(
  'UklGRjoAAABXRUJQVlA4IC4AAACyAgCdASoCAAIALmk0mk0iIiIiIgBoSygABc6WWgAA/veff/0PP8bA//LwYAAA',
  'base64',
);

test('OpenAI gpt-image streams SSE with keepalives, skips partial frames, and falls back only on unsupported stream param', async (t) => {
  const calls: Array<{ url: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: any) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url: String(url), body });
    const chunks = [
      ': heartbeat\r\n\r\n',
      `event: image_generation.partial_image\ndata: ${JSON.stringify({ type: 'image_generation.partial_image', b64_json: PNG_1X1.toString('base64') })}\n\n`,
      ': keepalive\n\n',
      `event: image_generation.completed\ndata: ${JSON.stringify({ type: 'image_generation.completed', b64_json: WEBP_2X2.toString('base64') })}\n\n`,
      'data: [DONE]',
    ];
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    );
  });
  const made = await generateImage(site, input, new AbortController().signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual([made.mime, made.width, made.height], ['image/webp', 2, 2]);

  // A relay that rejects `stream` as an unknown parameter falls back to non-streaming once.
  calls.length = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: any) => {
    const parsed = JSON.parse(init.body);
    calls.push({ url: String(url), body: parsed });
    if (parsed.stream)
      return Response.json({ error: { message: "Unknown parameter: 'stream'." } }, { status: 400 });
    return Response.json({ data: [{ b64_json: PNG_1X1.toString('base64') }] });
  });
  const fallback = await generateImage(site, input, new AbortController().signal);
  assert.deepEqual(calls.map((c) => Boolean(c.body.stream)), [true, false]);
  assert.equal(fallback.mime, 'image/png');

  // A prompt moderation 400 mentioning the word "stream" must NOT trigger a duplicate request.
  calls.length = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ error: { message: 'Safety system rejected prompt: mountain stream' } }, { status: 400 });
  });
  await assert.rejects(generateImage(site, input, new AbortController().signal), /mountain stream/);
  assert.equal(calls.length, 1);
});

test('Gemini 4K uses streamGenerateContent SSE, prefers non-thought final image, and explains 524 timeouts', async (t) => {
  const geminiSite: Site = { ...site, protocol: 'gemini', models: ['gemini-3.1-flash-image'] };
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    urls.push(String(url));
    const sse = [
      ':\n\n',
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'planning 4K composition' },
                { thought: true, inlineData: { mimeType: 'image/png', data: PNG_1X1.toString('base64') } },
              ],
            },
          },
        ],
      })}\n\n`,
      ':\n\n',
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: 'image/webp', data: WEBP_2X2.toString('base64') } }],
            },
            finishReason: 'STOP',
          },
        ],
      })}\n\n`,
    ].join('');
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  const result = await generateImage(
    geminiSite,
    { model: 'gemini-3.1-flash-image', prompt: 'snow peak', resolution: '4K', references: [] },
    new AbortController().signal,
  );
  assert.deepEqual(urls, ['https://example.invalid/v1beta/models/gemini-3.1-flash-image:streamGenerateContent?alt=sse']);
  assert.deepEqual([result.mime, result.width, result.height], ['image/webp', 2, 2]);

  // Cloudflare HTML 524 gets an explicit gateway-timeout warning instead of opaque HTML or retry.
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('<!DOCTYPE html><title>524: A timeout occurred</title>', { status: 524 }),
  );
  await assert.rejects(
    generateImage(geminiSite, { model: 'gemini-3.1-flash-image', prompt: 'x', resolution: '4K', references: [] }, new AbortController().signal),
    (failure: unknown) => {
      assert.ok(failure instanceof HttpError);
      assert.equal(failure.status, 502);
      assert.match(failure.message, /超时.*请勿盲目重试.*HTTP 524/);
      return true;
    },
  );
});
