// Mounts the real canvas page in jsdom against a stubbed API. It catches a blank or crashing
// page and wrong requests; it is not a substitute for looking at the page in a browser.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = join(import.meta.dirname, '..');
const out = mkdtempSync(join(tmpdir(), 'hrouter-canvas-web-'));
const image = (id: string, x: number, kind: string) => ({
  id,
  file: `${id}.png`,
  mime: 'image/png',
  width: 1536,
  height: 1024,
  x,
  y: 0,
  displayWidth: 320,
  kind,
  source: 'agent',
  prompt: kind === 'import' ? '' : '一只橘猫',
  model: kind === 'import' ? '' : 'gpt-image-2',
  site: 'Mine',
  createdAt: 1,
});
const state = {
  version: 'test',
  defaultSite: 'mine',
  current: 'b1',
  boards: [{ id: 'b1', title: '品牌海报', updatedAt: 1, count: 2 }],
  sites: [
    { id: 'mine', name: 'Mine', baseUrl: 'https://img.example', protocol: 'auto', models: ['gpt-image-2', 'gemini-3.1-flash-image'], hasKey: true, keyHint: '…cdef' },
    { id: 'hrouter', name: 'HRouter', baseUrl: 'https://hrouter.net', protocol: 'auto', models: [], hasKey: false, keyHint: '' },
  ],
};
const board = {
  id: 'b1',
  title: '品牌海报',
  viewport: { x: 0, y: 0, zoom: 1 },
  images: [image('aaaaaaaaaaaaaaaa', 0, 'import'), image('bbbbbbbbbbbbbbbb', 430, 'generated')],
  edges: [{ id: 'cccccccccccccccc', source: 'aaaaaaaaaaaaaaaa', target: 'bbbbbbbbbbbbbbbb' }],
  pending: [{ id: 'p1', prompt: 'x', model: 'gpt-image-2', startedAt: Date.now() }],
};

let page: any;
let authorized = true;
const calls: Array<{ url: string; method: string; body: any }> = [];
const errors: string[] = [];
const settle = async () => {
  for (let i = 0; i < 6; i++) await page.act(() => new Promise((resolve) => setTimeout(resolve, 30)));
};
// Globals read through to whichever jsdom window is current, so a second mount gets a fresh page.
let current: any;
const mirrored = new Set<string>();
const forced = ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'fetch'];
function install(url: string) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url, pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    confirm: () => true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    DOMMatrixReadOnly: class {
      m22 = 1;
    },
    EventSource: class {
      onerror: unknown;
      addEventListener() {}
      close() {}
    },
    fetch: async (input: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      calls.push({ url: input, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const reply = (status: number, value: unknown) =>
        new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      if (input === '/api/auth') return reply(200, { ok: true });
      if (!authorized) return reply(401, { error: '需要授权' });
      if (input === '/api/state') return reply(200, state);
      if (input === '/api/boards/b1' && method === 'GET') return reply(200, board);
      if (input === '/api/generate') return reply(200, { images: [{}], errors: [] });
      return reply(200, { ok: true });
    },
  });
  current = window;
  for (const key of [...Object.getOwnPropertyNames(window), ...forced]) {
    if (mirrored.has(key) || (key in globalThis && !forced.includes(key))) continue;
    mirrored.add(key);
    Object.defineProperty(globalThis, key, { configurable: true, get: () => current[key] });
  }
  // EventTarget methods live on the prototype and must stay bound to the window.
  for (const key of ['addEventListener', 'removeEventListener'])
    Object.defineProperty(globalThis, key, { configurable: true, get: () => current[key].bind(current) });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  return window;
}
async function mount(url: string) {
  const window = install(url);
  const root = page.createRoot(window.document.getElementById('root'));
  await page.act(() => root.render(page.createElement(page.App)));
  await settle();
  return { window, document: window.document as any, unmount: () => page.act(() => root.unmount()) };
}

before(async () => {
  await build({
    stdin: {
      contents: `export { default as App } from './web/src/App.tsx';
        export { createRoot } from 'react-dom/client';
        export { act, createElement } from 'react';`,
      resolveDir: root,
      loader: 'ts',
    },
    outfile: join(out, 'page.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  // React DOM probes for a browser when it is first evaluated, so a window must exist by then.
  install('http://127.0.0.1:17861/');
  page = await import(pathToFileURL(join(out, 'page.mjs')).href);
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
});
after(() => rmSync(out, { recursive: true, force: true }));

test('the canvas page renders the board and generates with the chosen options', async () => {
  const { window, document, unmount } = await mount('http://127.0.0.1:17861/#t=secret-token&settings');
  // The access token is exchanged once and removed from the address bar.
  assert.deepEqual(calls[0], { url: '/api/auth', method: 'POST', body: { token: 'secret-token' } });
  assert.equal(window.location.hash, '');

  assert.match(document.body.textContent!, /HRouter Canvas/);
  assert.equal(document.querySelectorAll('.image-node').length, 2);
  assert.equal(
    document.querySelector('.image-node img')!.getAttribute('src'),
    '/api/boards/b1/images/aaaaaaaaaaaaaaaa',
  );
  assert.match(document.querySelector('.generation-status')!.textContent!, /正在生成 1 张 · gpt-image-2/);
  // `#settings` opens the site settings, and the stored key is never rendered.
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.match(dialog.textContent!, /生图站点/);
  assert.equal((dialog.querySelector('input[type="password"]') as any).value, '');
  await page.act(() => (dialog.querySelector('[aria-label="关闭"]') as any).click());
  assert.equal(document.querySelector('[role="dialog"]'), null);

  // Only sites with a key are offered; mark an image as reference and generate.
  const options = (label: string) =>
    [...document.querySelectorAll(`.composer select[aria-label="${label}"] option`)].map((o: any) => o.textContent);
  assert.deepEqual(options('站点'), ['Mine']);
  assert.deepEqual(options('模型'), ['gpt-image-2', 'gemini-3.1-flash-image']);
  await page.act(() => (document.querySelector('[aria-label="用作参考图"]') as any).click());
  assert.equal(document.querySelectorAll('.refs button').length, 1);
  const textarea = document.querySelector('.composer textarea') as any;
  await page.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '加一顶帽子');
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const button = document.querySelector('.composer button.primary') as any;
  assert.equal(button.disabled, false);
  await page.act(() => button.click());
  await settle();
  assert.deepEqual(calls.find((c) => c.url === '/api/generate')!.body, {
    prompt: '加一顶帽子',
    boardId: 'b1',
    site: 'mine',
    model: 'gpt-image-2',
    references: ['aaaaaaaaaaaaaaaa'],
    count: 1,
  });
  assert.equal(textarea.value, '');
  await unmount();
  assert.deepEqual(errors, []);
});

test('an unauthorized browser sees how to open the canvas, not an empty page', async () => {
  authorized = false;
  const { document, unmount } = await mount('http://127.0.0.1:17861/');
  assert.match(document.body.textContent!, /需要从 agent 中打开画布/);
  assert.match(document.body.textContent!, /npx hrouter-canvas-mcp open/);
  await unmount();
});
