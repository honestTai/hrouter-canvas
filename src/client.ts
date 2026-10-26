import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PORT, ensureHome, headless, HttpError, secret, VERSION } from './config.ts';
import { daemonFile, probe } from './daemon.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function recordedPort(): number {
  try {
    const port = Number(JSON.parse(readFileSync(daemonFile(), 'utf8')).port);
    if (Number.isInteger(port) && port > 0) return port;
  } catch {
    // No daemon has written its port yet.
  }
  return Number(process.env.HROUTER_CANVAS_PORT) || DEFAULT_PORT;
}

export async function request<T = any>(
  port: number,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
    method: init.method || (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      Authorization: `Bearer ${secret()}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const value = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new HttpError(response.status, value.error || '画布服务请求失败');
  return value as T;
}

// One shared daemon serves every agent session on this machine. A daemon left over from an
// older package version is replaced so an npm update takes effect without manual steps.
export async function ensureDaemon(): Promise<number> {
  let port = recordedPort();
  const running = await probe(port);
  if (running?.version === VERSION) return port;
  if (running) {
    await request(port, 'shutdown', { method: 'POST' }).catch(() => {});
    for (let i = 0; i < 40 && (await probe(port)); i++) await sleep(100);
  }
  const log = openSync(join(ensureHome(), 'daemon.log'), 'a', 0o600);
  spawn(process.execPath, [...process.execArgv, process.argv[1], 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  }).unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    port = recordedPort();
    if ((await probe(port))?.version === VERSION) return port;
  }
  throw new Error(`画布服务启动失败，详见 ${join(ensureHome(), 'daemon.log')}`);
}

export const canvasUrl = (port: number, withToken = false, hash = '') =>
  `http://127.0.0.1:${port}/${withToken ? `#t=${secret()}${hash ? `&${hash}` : ''}` : hash ? `#${hash}` : ''}`;

export type OpenResult = 'opened' | 'already-open' | 'headless' | 'failed';
// The token rides in the URL fragment: it is never sent to a server or written to logs, and the
// page swaps it for an HttpOnly cookie and strips it from the address bar straight away.
export async function openCanvas(port: number, force = false, hash = ''): Promise<OpenResult> {
  if (!force && ((await probe(port))?.viewers || 0) > 0) return 'already-open';
  if (headless()) return 'headless';
  const url = canvasUrl(port, true, hash);
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args as string[], { stdio: 'ignore', detached: true });
      child.once('error', () => resolve('failed'));
      child.once('spawn', () => {
        child.unref();
        resolve('opened');
      });
    } catch {
      resolve('failed');
    }
  });
}
