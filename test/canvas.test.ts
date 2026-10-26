// End-to-end checks against a local fake image site. Nothing here calls a real provider,
// spends money, or opens a browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const root = join(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'hrouter-canvas-test-'));
process.env.HROUTER_CANVAS_HOME = home;
process.env.HROUTER_CANVAS_OPEN = 'never';
process.env.HROUTER_CANVAS_VIDEO_POLL_MS = '20';
// The fake MP4s cannot be decoded, so frames come from a fake canvas page instead of ffmpeg.
process.env.HROUTER_CANVAS_FFMPEG = 'off';

const { applyEnvSite, loadConfig, normalizeBaseUrl, normalizeVideoSite, saveConfig, secret } = await import(
  '../src/config.ts'
);
const { startDaemon } = await import('../src/daemon.ts');
const { inspectImage, inspectVideo, normalizeAspectRatio } = await import('../src/image.ts');
const { geminiRoot, openaiRoot } = await import('../src/providers.ts');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
// ftyp + moov(mvhd: 8000/1000 s, trak/tkhd: 1280×720) + mdat: the boxes a real MP4 carries.
const box = (type: string, ...parts: Buffer[]) => {
  const content = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(content.length + 8);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, content]);
};
const mvhd = Buffer.alloc(100);
mvhd.writeUInt32BE(1000, 12);
mvhd.writeUInt32BE(8000, 16);
const tkhd = Buffer.alloc(84);
tkhd.writeUInt32BE(1280 << 16, 76);
tkhd.writeUInt32BE(720 << 16, 80);
const MP4 = Buffer.concat([
  box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2', 'latin1')),
  box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd))),
  box('mdat', Buffer.alloc(64, 7)),
]);
const KEY = 'sk-test-0123456789abcdef';
const VIDEO_KEY = 'sk-video-fedcba9876543210';
const polls = new Map<string, number>();
const seen: Array<{ path: string; auth: string; type: string; body: string }> = [];
const body = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('latin1');
};
const upstream = createServer(async (request, response) => {
  const path = request.url || '';
  const text = await body(request);
  seen.push({
    path,
    auth: String(request.headers.authorization || request.headers['x-goog-api-key'] || ''),
    type: String(request.headers['content-type'] || ''),
    body: text,
  });
  const json = (status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (path === '/files/interrupted.png') {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    response.write(PNG.subarray(0, 20));
    setTimeout(() => response.destroy(), 30);
    return;
  }
  if (path === '/files/result.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    return response.end(PNG);
  }
  if (path === '/files/clip.mp4') {
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    return response.end(MP4);
  }
  // The video key only works for video endpoints, like a key from a video-only group.
  const keys = path.startsWith('/v1/videos') ? [KEY, VIDEO_KEY] : [KEY];
  if (!keys.some((key) => request.headers.authorization === `Bearer ${key}`))
    return json(401, { error: { message: 'bad key sk-leak' } });
  if (path === '/v1/videos/generations') {
    const model = JSON.parse(text).model;
    // What HRouter answers when the key's group cannot make videos.
    if (model === 'wrong-group') return json(404, { error: { message: 'Videos API is not supported for this platform' } });
    return json(200, { request_id: model === 'video-fails' ? 'vid-fail' : model === 'xai-direct' ? 'vid-xai' : 'vid-ok' });
  }
  if (path === '/v1/videos/generations/vid-ok') {
    const n = (polls.get(path) || 0) + 1;
    polls.set(path, n);
    // Pending first, then a few transient gateway errors, then done.
    if (n === 1) return json(200, { status: 'pending' });
    if (n === 2) return json(503, { error: { message: 'busy' } });
    polls.delete(path);
    return json(200, { status: 'done', video: { url: 'https://upstream.invalid/temp.mp4' } });
  }
  if (path === '/v1/videos/generations/vid-ok/content') {
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    return response.end(MP4);
  }
  if (path === '/v1/videos/generations/vid-fail')
    return json(200, { status: 'failed', error: { message: 'moderation blocked' } });
  if (path === '/v1/videos/vid-xai')
    return json(200, { status: 'done', video: { url: `http://127.0.0.1:${upstreamPort}/files/clip.mp4` } });
  if (path === '/v1/videos') return json(200, { id: 'video_1', status: 'queued' });
  if (path === '/v1/videos/video_1') return json(200, { id: 'video_1', status: 'completed' });
  if (path === '/v1/videos/video_1/content') {
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    return response.end(MP4);
  }
  if (path === '/v1/models')
    return json(200, { data: [{ id: 'gpt-image-2' }, { id: 'gpt-5' }, { id: 'gemini-3.1-flash-image' }] });
  if (path === '/v1/images/generations') {
    if (text.includes('"model":"interrupted-response"')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"data":[');
      setTimeout(() => response.destroy(), 30);
      return;
    }
    if (text.includes('"model":"interrupted-image"'))
      return json(200, { data: [{ url: `http://127.0.0.1:${upstreamPort}/files/interrupted.png` }] });
    if (text.includes('"model":"gateway-timeout"')) return json(504, { error: { message: 'gateway timeout' } });
    if (text.includes('"model":"broken"')) return json(500, { error: { message: 'model exploded' } });
    return json(200, { data: [{ b64_json: PNG.toString('base64') }] });
  }
  if (path === '/v1/images/edits')
    return json(200, { data: [{ url: `http://127.0.0.1:${upstreamPort}/files/result.png` }] });
  if (path === '/v1beta/models/gemini-3.1-flash-image:generateContent')
    return json(200, {
      candidates: [
        { content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } },
      ],
    });
  json(404, { error: { message: 'not found' } });
});
let upstreamPort = 0;
let daemon: Awaited<ReturnType<typeof startDaemon>>;
let token = '';

const call = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const response = await fetch(`${daemon.url}api/${path}`, {
    ...init,
    method: init.method || (init.json !== undefined ? 'POST' : 'GET'),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  return { status: response.status, value: (await response.json().catch(() => ({}))) as any, response };
};

before(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as { port: number }).port;
  applyEnvSite({
    HROUTER_CANVAS_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    HROUTER_CANVAS_API_KEY: KEY,
    HROUTER_CANVAS_MODEL: 'gpt-image-2',
  });
  token = secret();
  daemon = await startDaemon({ port: 0, webDir: join(root, 'dist', 'web') });
});
after(async () => {
  await daemon.close();
  upstream.close();
  rmSync(home, { recursive: true, force: true });
});

test('pure helpers', () => {
  assert.equal(openaiRoot('https://a.com'), 'https://a.com/v1');
  assert.equal(openaiRoot('https://a.com/v1/'), 'https://a.com/v1');
  assert.equal(openaiRoot('https://a.com/api/v3'), 'https://a.com/api/v3');
  assert.equal(geminiRoot('https://a.com/v1beta'), 'https://a.com/v1beta');
  assert.equal(geminiRoot('https://a.com/v1'), 'https://a.com/v1beta');
  assert.equal(normalizeAspectRatio('32:18'), '16:9');
  assert.equal(normalizeAspectRatio('16:9; rm'), null);
  assert.deepEqual(inspectImage(new Uint8Array(PNG)), { mime: 'image/png', width: 1, height: 1 });
  assert.throws(() => inspectImage(new TextEncoder().encode('<html>not an image</html>')));
  assert.deepEqual(inspectVideo(new Uint8Array(MP4)), { mime: 'video/mp4', width: 1280, height: 720, duration: 8 });
  assert.throws(() => inspectVideo(new Uint8Array(PNG)), /MP4/);
  // Video sites are a list of their own; a config from before video support gets the HRouter
  // video preset, keyless, and image sites are left exactly as they were.
  const path = join(home, 'config.json');
  const saved = readFileSync(path, 'utf8');
  writeFileSync(path, JSON.stringify({ sites: JSON.parse(saved).sites, defaultSite: 'env' }));
  const legacy = loadConfig();
  assert.deepEqual(legacy.sites, JSON.parse(saved).sites);
  assert.deepEqual(
    legacy.videoSites.map((s) => [s.id, s.apiKey, s.models, s.defaultModel]),
    [['hrouter-video', '', ['grok-imagine-video-1.5', 'grok-imagine-video'], 'grok-imagine-video-1.5']],
  );
  assert.equal(legacy.defaultVideoSite, 'hrouter-video');
  writeFileSync(path, saved);
  assert.throws(() => normalizeVideoSite({ id: 'v', baseUrl: 'https://a.com', protocol: 'gemini' }), /协议/);
  assert.equal(normalizeBaseUrl('https://a.com/'), 'https://a.com');
  assert.equal(normalizeBaseUrl('http://192.168.1.5:3000'), 'http://192.168.1.5:3000');
  assert.throws(() => normalizeBaseUrl('http://example.com'), /https/);
  assert.throws(() => normalizeBaseUrl('https://user:pw@example.com'));
});

test('secrets on disk are private', { skip: process.platform === 'win32' }, () => {
  for (const file of ['config.json', 'secret', 'daemon.json'])
    assert.equal(statSync(join(home, file)).mode & 0o077, 0, file);
});

test('access control', async () => {
  const health = await fetch(`${daemon.url}api/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as any).app, 'hrouter-canvas');
  assert.equal((await fetch(`${daemon.url}api/state`)).status, 401);
  assert.equal((await call('auth', { json: { token: 'nope' }, headers: { Authorization: '' } })).status, 401);
  // Another website driving the user's browser: wrong Origin, and a rebinding Host.
  assert.equal((await call('boards', { json: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  const rebound = await new Promise<number>((resolve) =>
    httpRequest(
      { host: '127.0.0.1', port: daemon.port, path: '/api/health', headers: { Host: 'evil.example' } },
      (response) => resolve(response.statusCode || 0),
    ).end(),
  );
  assert.equal(rebound, 403);
  // Agent-only operations are refused for a browser session.
  const cookie = (await call('auth', { json: { token } })).response.headers.getSetCookie()[0].split(';')[0];
  assert.match(cookie, /^hc_session=[a-f0-9]{64}$/);
  const asPage = { headers: { Authorization: '', Cookie: cookie } };
  assert.equal((await call('state', asPage)).status, 200);
  assert.equal((await call('shutdown', { ...asPage, method: 'POST' })).status, 403);
  const sneaky = await call('generate', { ...asPage, json: { prompt: 'x', references: ['/etc/hosts'] } });
  assert.equal(sneaky.status, 400);
  const page = await fetch(daemon.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
});

test('the API key never leaves the service', async () => {
  const state = await call('state');
  assert.equal(state.status, 200);
  assert.ok(!JSON.stringify(state.value).includes(KEY));
  assert.deepEqual(
    state.value.sites.map((s: any) => [s.id, s.hasKey, s.keyHint]),
    [['env', true, '…cdef'], ['hrouter', false, '']],
  );
  // Saving without a key keeps the stored one; plain http to a public host is refused.
  const kept = await call('sites/env', {
    method: 'PUT',
    json: { name: 'Renamed', baseUrl: `http://127.0.0.1:${upstreamPort}`, protocol: 'auto', models: ['gpt-image-2', 'gemini-3.1-flash-image', 'broken'] },
  });
  assert.equal(kept.status, 200);
  assert.equal(loadConfig().sites.find((s) => s.id === 'env')?.apiKey, KEY);
  const insecure = await call('sites/other', {
    method: 'PUT',
    json: { name: 'x', baseUrl: 'http://example.com', protocol: 'auto', apiKey: 'k', models: [] },
  });
  assert.equal(insecure.status, 400);
  const models = await call('sites/env/models', { method: 'POST' });
  assert.deepEqual(models.value.suggested, ['gemini-3.1-flash-image', 'gpt-image-2']);
  assert.equal(models.value.all.length, 3);
});

test('generate, reference, save and show on the board', async () => {
  const events: string[] = [];
  const stream = await fetch(`${daemon.url}api/events`, { headers: { Authorization: `Bearer ${token}` } });
  const reader = stream.body!.getReader();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      events.push(new TextDecoder().decode(value));
    }
  })();

  const first = await call('generate', { json: { prompt: '一只橘猫', aspectRatio: '16:9' } });
  assert.equal(first.status, 200, JSON.stringify(first.value));
  const [image] = first.value.images;
  assert.deepEqual(readFileSync(image.path), PNG);
  assert.equal(first.value.protocol, 'openai');
  // The fake site keeps raw bytes (latin1) so multipart survives; JSON bodies are UTF-8.
  const sent = JSON.parse(
    Buffer.from(seen.findLast((r) => r.path === '/v1/images/generations')!.body, 'latin1').toString('utf8'),
  );
  assert.equal(sent.size, 'auto');
  assert.match(sent.prompt, /^\[Aspect ratio 16:9, landscape composition\]\n\n一只橘猫$/);
  assert.ok(!('response_format' in sent));

  // An absolute path reference is imported, sent as multipart, and the URL result is downloaded.
  const source = join(home, 'source.png');
  writeFileSync(source, PNG);
  const out = join(home, 'out');
  const edit = await call('generate', {
    json: { prompt: '加一顶帽子', references: [source], saveTo: out, count: 2 },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.value));
  assert.equal(edit.value.images.length, 2);
  const upload = seen.findLast((r) => r.path === '/v1/images/edits')!;
  assert.match(upload.type, /^multipart\/form-data/);
  assert.match(upload.body, /name="image\[\]"; filename="reference-0\.png"/);
  for (const made of edit.value.images) {
    assert.ok(made.savedTo.startsWith(out) && existsSync(made.savedTo));
    assert.deepEqual(readFileSync(made.savedTo), PNG);
  }
  assert.notEqual(edit.value.images[0].savedTo, edit.value.images[1].savedTo);

  const gemini = await call('generate', { json: { prompt: 'a fox', model: 'gemini-3.1-flash-image', resolution: '2K' } });
  assert.equal(gemini.status, 200, JSON.stringify(gemini.value));
  assert.equal(gemini.value.protocol, 'gemini');
  const native = JSON.parse(seen.findLast((r) => r.path.includes(':generateContent'))!.body);
  assert.deepEqual(native.generationConfig.imageConfig, { imageSize: '2K' });

  const board = (await call(`boards/${first.value.board.id}`)).value;
  assert.equal(board.images.length, 5);
  assert.equal(board.images.filter((i: any) => i.kind === 'import').length, 1);
  const imported = board.images.find((i: any) => i.kind === 'import');
  assert.equal(board.edges.filter((e: any) => e.source === imported.id).length, 2);
  assert.equal(board.pending.length, 0);
  // No two cards overlap after automatic placement.
  const boxes = board.images.map((i: any) => [i.x, i.y, i.x + i.displayWidth, i.y + i.displayWidth]);
  for (const [a, one] of boxes.entries())
    for (const two of boxes.slice(a + 1))
      assert.ok(one[2] <= two[0] || two[2] <= one[0] || one[3] <= two[1] || two[3] <= one[1]);

  const served = await call(`boards/${board.id}/images/${image.id}`);
  assert.equal(served.response.headers.get('content-type'), 'image/png');
  await reader.cancel();
  assert.ok(events.join('').includes('event: change'));
});

test('failures are explained and nothing is saved', async () => {
  const before = (await call('state')).value.boards[0].count;
  const broken = await call('generate', { json: { prompt: 'x', model: 'broken' } });
  assert.equal(broken.status, 502);
  assert.match(broken.value.error, /HTTP 500.*model exploded/);
  assert.equal((await call('generate', { json: { prompt: 'x', aspectRatio: 'wide' } })).status, 400);
  assert.equal((await call('generate', { json: { prompt: 'x', site: 'hrouter' } })).status, 409);
  assert.equal((await call('generate', { json: { prompt: 'x', saveTo: 'relative/dir' } })).status, 400);

  const config = loadConfig();
  saveConfig({ ...config, sites: config.sites.map((s) => (s.id === 'env' ? { ...s, apiKey: 'sk-wrong-key-000000' } : s)) });
  const denied = await call('generate', { json: { prompt: 'x' } });
  assert.equal(denied.status, 403);
  assert.match(denied.value.error, /API Key 无效/);
  saveConfig(config);
  assert.equal((await call('state')).value.boards[0].count, before);
});

test('interrupted result transfers preserve their stage and do not retry generation', async () => {
  const before = (await call('state')).value.boards[0].count;
  for (const [model, message] of [
    ['interrupted-response', /读取生图接口响应.*连接中断.*UND_ERR_SOCKET/],
    ['interrupted-image', /下载生成图片.*连接中断.*UND_ERR_SOCKET/],
    ['gateway-timeout', /HTTP 504.*gateway timeout/],
  ] as const) {
    const countBefore = seen.filter((r) => r.path === '/v1/images/generations').length;
    const result = await call('generate', { json: { prompt: 'x', model } });
    assert.equal(result.status, 502);
    assert.match(result.value.error, message);
    assert.ok(!result.value.error.includes(KEY));
    assert.equal(seen.filter((r) => r.path === '/v1/images/generations').length, countBefore + 1);
    const state = (await call('state')).value;
    assert.equal(state.boards[0].count, before);
    assert.equal((await call(`boards/${state.boards[0].id}`)).value.pending.length, 0);
  }
});

const waitJob = async (id: string) => {
  for (;;) {
    const job = (await call(`videos/${id}`)).value;
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('an image from one site becomes a video on another site', async () => {
  // The env site only draws and the HRouter preset has no key yet, so there is no video site.
  assert.equal((await call('videos', { json: { prompt: 'x' } })).status, 409);
  // Site 2: a video-only site with its own key, separate from the image sites.
  const site = await call('video-sites/vid', {
    method: 'PUT',
    json: {
      name: 'Video',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      protocol: 'auto',
      apiKey: VIDEO_KEY,
      models: ['grok-imagine-video-1.5', 'sora-2', 'video-fails', 'xai-direct', 'wrong-group'],
    },
  });
  assert.equal(site.status, 200, JSON.stringify(site.value));
  assert.equal((await call('video-sites/vid/default', { method: 'POST' })).status, 200);
  const state = (await call('state')).value;
  assert.equal(state.defaultSite, 'env');
  assert.equal(state.defaultVideoSite, 'vid');
  assert.deepEqual(state.sites.map((s: any) => s.id), ['env', 'hrouter']);
  assert.deepEqual(state.videoSites.map((s: any) => [s.id, s.hasKey]), [['hrouter-video', false], ['vid', true]]);
  assert.ok(!JSON.stringify(state).includes(VIDEO_KEY));

  const still = await call('generate', { json: { prompt: '海边的灯塔' } });
  assert.equal(still.status, 200, JSON.stringify(still.value));
  assert.equal(seen.findLast((r) => r.path === '/v1/images/generations')!.auth, `Bearer ${KEY}`);
  const [image] = still.value.images;

  const out = join(home, 'clips');
  const started = await call('videos', {
    json: { prompt: '镜头缓慢推进，海浪拍打礁石', image: image.id, duration: 8, resolution: '720P', aspectRatio: '9:16', saveTo: out },
  });
  assert.equal(started.status, 200, JSON.stringify(started.value));
  assert.equal(started.value.status, 'running');
  assert.equal(started.value.model, 'grok-imagine-video-1.5');
  const job = await waitJob(started.value.id);
  assert.equal(job.status, 'done', job.error);
  const submit = seen.findLast((r) => r.path === '/v1/videos/generations')!;
  assert.equal(submit.auth, `Bearer ${VIDEO_KEY}`);
  const sent = JSON.parse(Buffer.from(submit.body, 'latin1').toString('utf8'));
  assert.deepEqual(
    { ...sent, image: undefined },
    { model: 'grok-imagine-video-1.5', prompt: '镜头缓慢推进，海浪拍打礁石', duration: 8, resolution: '720p', image: undefined },
  );
  assert.equal(sent.image.url, `data:image/png;base64,${PNG.toString('base64')}`);
  // Downloaded through HRouter's /content, not the temporary upstream link.
  assert.ok(seen.some((r) => r.path === '/v1/videos/generations/vid-ok/content'));
  assert.deepEqual(readFileSync(job.video.path), MP4);
  assert.ok(job.video.savedTo.startsWith(out) && job.video.savedTo.endsWith('.mp4'));
  assert.deepEqual([job.video.width, job.video.height, job.video.duration], [1280, 720, 8]);

  const board = (await call(`boards/${job.board.id}`)).value;
  const node = board.images.find((i: any) => i.id === job.video.id);
  assert.equal(node.mime, 'video/mp4');
  assert.ok(board.edges.some((e: any) => e.source === image.id && e.target === node.id));
  assert.equal(board.pending.length, 0);
  // Browsers fetch videos in ranges to seek.
  const part = await call(`boards/${board.id}/images/${node.id}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(part.response.status, 206);
  assert.equal(part.response.headers.get('content-range'), `bytes 0-9/${MP4.length}`);
  assert.equal(part.response.headers.get('content-type'), 'video/mp4');

  // OpenAI-style /v1/videos, chosen automatically for sora- models.
  const sora = await waitJob((await call('videos', { json: { prompt: 'x', image: image.id, model: 'sora-2', duration: 4, resolution: '720p' } })).value.id);
  assert.equal(sora.status, 'done', sora.error);
  assert.equal(sora.protocol, 'openai');
  const form = seen.findLast((r) => r.path === '/v1/videos')!;
  assert.match(form.type, /^multipart\/form-data/);
  assert.match(form.body, /name="seconds"\r\n\r\n4\r\n/);
  assert.match(form.body, /name="size"\r\n\r\n720x1280|name="size"\r\n\r\n1280x720/);
  assert.match(form.body, /name="input_reference"; filename="reference\.png"/);

  // xAI's own status path and a result link are used when the HRouter path does not exist.
  const direct = await waitJob((await call('videos', { json: { prompt: 'x', model: 'xai-direct' } })).value.id);
  assert.equal(direct.status, 'done', direct.error);

  // A failed task is reported with the site's reason and never resubmitted.
  const submits = seen.filter((r) => r.path === '/v1/videos/generations').length;
  const failed = await waitJob((await call('videos', { json: { prompt: 'x', model: 'video-fails' } })).value.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /失败（任务 vid-fail）：moderation blocked/);
  assert.equal(seen.filter((r) => r.path === '/v1/videos/generations').length, submits + 1);
  const group = await waitJob((await call('videos', { json: { prompt: 'x', model: 'wrong-group' } })).value.id);
  assert.match(group.error, /Key 不能生视频（Videos API is not supported for this platform）.*生视频站点/);
  assert.equal((await call('videos', { json: { prompt: 'x', duration: 0 } })).status, 400);
  assert.ok(!JSON.stringify((await call('videos')).value).includes(VIDEO_KEY));
});

test('agents can list the canvas, look at a video and build on its frames', async () => {
  const canvas = (await call('canvas')).value;
  // An image-to-video clip from the previous test.
  const video = canvas.items.find((i: any) => i.type === 'video' && i.from.length);
  assert.ok(video.path.endsWith('.mp4'));
  assert.equal(video.duration, 8);
  assert.equal(canvas.items.find((i: any) => i.id === video.from[0]).type, 'image');
  // The page reports the selection; unknown ids are dropped.
  await call(`boards/${canvas.board.id}/selection`, { json: { ids: [video.id, 'ffffffffffffffff'] } });
  assert.deepEqual((await call('canvas')).value.selected, [video.id]);

  // No ffmpeg and, in a headless session, no page to decode with: say so at once.
  const blind = await call(`items/${video.id}/view`);
  assert.equal(blind.status, 503);
  assert.match(blind.value.error, /ffmpeg/);

  // An open page decodes frames with the browser and posts them back.
  const asked: any[] = [];
  const stream = await fetch(`${daemon.url}api/events`, { headers: { Authorization: `Bearer ${token}` } });
  const reader = stream.body!.getReader();
  void (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buffer += new TextDecoder().decode(value);
      for (let end; (end = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(end + 2)) {
        const block = buffer.slice(0, end);
        if (!block.startsWith('event: frames')) continue;
        const wanted = JSON.parse(block.split('\ndata: ')[1]);
        asked.push(wanted);
        await call(`frames/${wanted.id}`, { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png' } });
      }
    }
  })();
  const look = await call(`items/${video.id}/view`);
  assert.equal(look.status, 200, JSON.stringify(look.value));
  assert.equal(look.value.picture.data, PNG.toString('base64'));
  assert.match(look.value.note, /四格/);
  assert.deepEqual(asked.map((a) => [a.kind, a.url]), [['sheet', `/api/boards/${canvas.board.id}/images/${video.id}`]]);
  // The sheet is cached next to the board.
  assert.equal((await call(`items/${video.id}/view`)).status, 200);
  assert.equal(asked.length, 1);
  assert.equal((await call(`frames/${asked[0].id}`, { method: 'POST', body: PNG })).status, 404);
  const still = await call(`items/${video.from[0]}/view`);
  assert.equal(still.value.picture.data, PNG.toString('base64'));

  // A frame becomes its own image, linked from the video; taking it again reuses it.
  const frame = await call(`items/${video.id}/frame`, { json: { at: 'last' } });
  assert.equal(frame.status, 200, JSON.stringify(frame.value));
  assert.deepEqual([asked[1].kind, asked[1].at], ['frame', 'last']);
  assert.deepEqual(readFileSync(frame.value.path), PNG);
  assert.equal((await call(`items/${video.id}/frame`, { json: { at: 'last' } })).value.id, frame.value.id);
  const listed = (await call('canvas')).value.items.find((i: any) => i.id === frame.value.id);
  assert.deepEqual([listed.type, listed.frame, listed.from], ['frame', { of: video.id, at: 'last' }, [video.id]]);
  assert.equal((await call(`items/${video.id}/frame`, { json: { at: 'middle' } })).status, 400);
  assert.equal((await call(`items/${video.id}/frame`, { json: { at: 99 } })).status, 400);

  // A video is not an image reference; the error says how to get a frame.
  const ref = await call('generate', { json: { prompt: 'x', references: [video.id] } });
  assert.equal(ref.status, 400);
  assert.match(ref.value.error, /extract_frame/);

  // Passing a video as the start continues it from its last frame.
  const next = await waitJob((await call('videos', { json: { prompt: '接着往前走', image: video.id } })).value.id);
  assert.equal(next.status, 'done', next.error);
  const board = (await call(`boards/${canvas.board.id}`)).value;
  assert.ok(board.edges.some((e: any) => e.source === frame.value.id && e.target === next.video.id));
  await reader.cancel();
});

test('the MCP server exposes the tools and generates through the shared service', async () => {
  const mcpHome = mkdtempSync(join(tmpdir(), 'hrouter-canvas-mcp-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env,
    HROUTER_CANVAS_HOME: mcpHome,
    HROUTER_CANVAS_PORT: String(port),
    HROUTER_CANVAS_OPEN: 'never',
    HROUTER_CANVAS_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    HROUTER_CANVAS_API_KEY: KEY,
    HROUTER_CANVAS_MODEL: 'gpt-image-2',
    HROUTER_CANVAS_VIDEO_MODEL: 'grok-imagine-video-1.5',
  };
  const cli = join(root, 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [cli, 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  const waiting = new Map<number, (value: any) => void>();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
      const message = JSON.parse(buffer.slice(0, end));
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    const hello = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(hello.result.serverInfo.name, 'hrouter-canvas');
    assert.match(hello.result.instructions, /generate_image/);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = (await rpc('tools/list', {})).result.tools;
    assert.deepEqual(tools.map((t: any) => t.name).sort(), [
      'extract_frame',
      'generate_image',
      'generate_video',
      'list_canvas',
      'list_image_models',
      'open_canvas',
      'video_status',
      'view_canvas_item',
    ]);
    // No tool may accept a site address or API key from the model.
    assert.ok(!/api_?key|base_?url/i.test(JSON.stringify(tools.map((t: any) => t.inputSchema))));

    const made = await rpc('tools/call', { name: 'generate_image', arguments: { prompt: 'a red bicycle', aspect_ratio: '1:1' } });
    assert.ok(!made.result.isError, made.result.content[0].text);
    const path = /^- (\/.+\.png) \(1×1/m.exec(made.result.content[0].text)?.[1];
    assert.ok(path && path.startsWith(mcpHome), made.result.content[0].text);
    assert.deepEqual(readFileSync(path), PNG);
    assert.match(made.result.content[0].text, /No browser here/);
    assert.ok(!made.result.content[0].text.includes(KEY));

    // Agent-driven image-to-video: the generated still's path becomes the first frame.
    const clip = await rpc('tools/call', { name: 'generate_video', arguments: { prompt: '车轮转动起来', image: path } });
    assert.ok(!clip.result.isError, clip.result.content[0].text);
    const video = /^- (\/.+\.mp4) \(1280×720, 8s/m.exec(clip.result.content[0].text)?.[1];
    assert.ok(video && video.startsWith(mcpHome), clip.result.content[0].text);
    assert.deepEqual(readFileSync(video), MP4);
    // Headless with no ffmpeg: the video is still delivered, just without keyframes.
    assert.match(clip.result.content[0].text, /Keyframes unavailable: .*ffmpeg/);
    const jobs = await rpc('tools/call', { name: 'video_status', arguments: {} });
    assert.match(jobs.result.content[0].text, /Video ready \(job v[a-f0-9]{12}, grok-imagine-video-1\.5/);

    // The agent can see what is on the canvas and look at an item.
    const board = (await rpc('tools/call', { name: 'list_canvas', arguments: {} })).result.content[0].text;
    const videoId = new RegExp(`^- ([a-f0-9]{16}): video by grok-imagine-video-1\\.5 via 环境变量视频站点, 1280×720, 8s\\n  prompt: 车轮转动起来\\n  made from: ([a-f0-9]{16})\\n  file: ${video.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(board);
    assert.ok(videoId, board);
    assert.match(board, /Nothing is selected on the canvas/);
    const seen = await rpc('tools/call', { name: 'view_canvas_item', arguments: { id: videoId[2] } });
    assert.ok(!seen.result.isError, seen.result.content[0].text);
    assert.deepEqual(seen.result.content[1], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });

    const listed = await rpc('tools/call', { name: 'list_image_models', arguments: {} });
    assert.match(listed.result.content[0].text, /^Image sites[^]*site id: env\) \[default\]\n  models: gpt-image-2/);
    assert.match(listed.result.content[0].text, /Video sites[^]*site id: env\) \[default\]\n  models: grok-imagine-video-1\.5/);
    assert.ok(!listed.result.content[0].text.includes(KEY));
  } finally {
    child.kill();
    await new Promise<void>((resolve) =>
      spawn(process.execPath, [cli, 'stop'], { env, stdio: 'ignore' }).on('exit', () => resolve()),
    );
    rmSync(mcpHome, { recursive: true, force: true });
  }
});
