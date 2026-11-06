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
});
