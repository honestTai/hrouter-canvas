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

const { applyEnvSite, loadConfig, normalizeBaseUrl, saveConfig, secret } = await import(
  '../src/config.ts'
);
const { startDaemon } = await import('../src/daemon.ts');
const { inspectImage, normalizeAspectRatio } = await import('../src/image.ts');
const { geminiRoot, openaiRoot } = await import('../src/providers.ts');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const KEY = 'sk-test-0123456789abcdef';
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
  if (path === '/files/result.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    return response.end(PNG);
  }
  if (request.headers.authorization !== `Bearer ${KEY}`)
    return json(401, { error: { message: 'bad key sk-leak' } });
  if (path === '/v1/models')
    return json(200, { data: [{ id: 'gpt-image-2' }, { id: 'gpt-5' }, { id: 'gemini-3.1-flash-image' }] });
  if (path === '/v1/images/generations') {
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
    assert.deepEqual(tools.map((t: any) => t.name).sort(), ['generate_image', 'list_image_models', 'open_canvas']);
    // No tool may accept a site address or API key from the model.
    assert.ok(!/api_?key|base_?url/i.test(JSON.stringify(tools.map((t: any) => t.inputSchema))));

    const made = await rpc('tools/call', { name: 'generate_image', arguments: { prompt: 'a red bicycle', aspect_ratio: '1:1' } });
    assert.ok(!made.result.isError, made.result.content[0].text);
    const path = /^- (\/.+\.png) \(1×1/m.exec(made.result.content[0].text)?.[1];
    assert.ok(path && path.startsWith(mcpHome), made.result.content[0].text);
    assert.deepEqual(readFileSync(path), PNG);
    assert.match(made.result.content[0].text, /No browser here/);
    assert.ok(!made.result.content[0].text.includes(KEY));

    const listed = await rpc('tools/call', { name: 'list_image_models', arguments: {} });
    assert.match(listed.result.content[0].text, /site id: env\) \[default\]/);
    assert.ok(!listed.result.content[0].text.includes(KEY));
  } finally {
    child.kill();
    await new Promise<void>((resolve) =>
      spawn(process.execPath, [cli, 'stop'], { env, stdio: 'ignore' }).on('exit', () => resolve()),
    );
    rmSync(mcpHome, { recursive: true, force: true });
  }
});
