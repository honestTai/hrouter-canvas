import { createHmac, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT,
  ensureHome,
  home,
  HttpError,
  loadConfig,
  normalizeSite,
  publicSite,
  resolveSite,
  saveConfig,
  secret,
  VERSION,
  writePrivate,
} from './config.ts';
import { imageExtension, MAX_IMPORT_BYTES, normalizeAspectRatio } from './image.ts';
import { generateImage, listModels, protocolFor, type Reference } from './providers.ts';
import { Store, type Board, type CanvasImage } from './store.ts';

export interface Daemon {
  port: number;
  url: string;
  close(): Promise<void>;
}
export class AlreadyRunning extends Error {}
interface Pending {
  id: string;
  boardId: string;
  prompt: string;
  model: string;
  startedAt: number;
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const safeModel = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,119}$/;
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const slug = (prompt: string) =>
  prompt
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '') || 'image';

export const daemonFile = () => join(home(), 'daemon.json');
export async function probe(port: number): Promise<{ version: string; viewers: number } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const value = (await response.json()) as { app?: string; version?: string; viewers?: number };
    return value.app === 'hrouter-canvas'
      ? { version: String(value.version), viewers: Number(value.viewers) || 0 }
      : null;
  } catch {
    return null;
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  if (Number(request.headers['content-length'] || 0) > limit)
    throw new HttpError(413, '请求超过大小限制');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求超过大小限制');
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBody(request, 1024 * 1024);
  if (!bytes.length) return {};
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Fall through to the shared error.
  }
  throw new HttpError(400, '请求格式无效');
}

export async function startDaemon(
  options: { port?: number; webDir?: string; idleMinutes?: number } = {},
): Promise<Daemon> {
  ensureHome();
  const token = secret();
  const cookie = createHmac('sha256', token).update('hrouter-canvas-cookie').digest('hex');
  const webDir =
    options.webDir ||
    process.env.HROUTER_CANVAS_WEB_DIR ||
    join(dirname(fileURLToPath(import.meta.url)), 'web');
  const store = new Store();
  const pending = new Map<string, Pending>();
  const viewers = new Set<ServerResponse>();
  const shutdown = new AbortController();
  let port = 0,
    inFlight = 0,
    lastActivity = Date.now(),
    pendingSeq = 0;

  const emit = (boardId?: string) => {
    const frame = `event: change\ndata: ${JSON.stringify({ boardId: boardId || null })}\n\n`;
    for (const viewer of viewers) viewer.write(frame);
  };
  const send = (response: ServerResponse, status: number, body: unknown, headers = {}) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    response.end(JSON.stringify(body));
  };

  // References are canvas image ids; agents may also pass absolute paths, which are imported
  // onto the board first so the canvas shows what a result was made from.
  function references(board: Board, value: unknown, agent: boolean) {
    const list = Array.isArray(value) ? value : [];
    if (list.length > 8) throw new HttpError(400, '最多使用 8 张参考图');
    const ids: string[] = [],
      refs: Reference[] = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item) throw new HttpError(400, '参考图无效');
      let image = board.images.find((i) => i.id === item);
      if (!image) {
        if (!agent || !isAbsolute(item))
          throw new HttpError(400, `参考图不存在：${item.slice(0, 200)}`);
        let bytes: Uint8Array;
        try {
          if (statSync(item).size > MAX_IMPORT_BYTES) throw new HttpError(413, '');
          bytes = new Uint8Array(readFileSync(item));
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof HttpError ? `参考图超过 20 MB：${item}` : `无法读取参考图：${item}`,
          );
        }
        image = store.add(board, bytes, {
          kind: 'import',
          source: 'agent',
          prompt: '',
          model: '',
          site: '',
        });
      }
      ids.push(image.id);
      refs.push({ bytes: store.read(board, image.id).bytes, mime: image.mime });
    }
    return { ids, refs };
  }

  function exportCopy(board: Board, image: CanvasImage, saveTo: string, index: number): string {
    const extension = imageExtension(image.mime);
    const named = /\.(png|jpe?g|webp)$/i.test(saveTo);
    let stem = named
      ? saveTo.replace(/\.[^.]+$/, '') + (index ? `-${index + 1}` : '')
      : join(saveTo, `${slug(image.prompt)}-${image.id.slice(0, 6)}`);
    mkdirSync(dirname(stem), { recursive: true });
    // Never overwrite a file the user already has.
    for (let n = 1; existsSync(`${stem}.${extension}`); n++)
      stem = stem.replace(/(?:-copy\d+)?$/, `-copy${n}`);
    copyFileSync(store.imagePath(board, image), `${stem}.${extension}`);
    return `${stem}.${extension}`;
  }

  async function generate(body: Record<string, unknown>, agent: boolean) {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 8000) throw new HttpError(400, '提示词不能为空，且不超过 8000 字');
    const count = body.count === undefined ? 1 : Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 4)
      throw new HttpError(400, '一次生成 1 到 4 张');
    const aspectRatio =
      body.aspectRatio === undefined || body.aspectRatio === ''
        ? undefined
        : normalizeAspectRatio(body.aspectRatio);
    if (aspectRatio === null) throw new HttpError(400, '画面比例无效，应类似 16:9');
    const resolution = body.resolution || undefined;
    if (resolution !== undefined && resolution !== '1K' && resolution !== '2K' && resolution !== '4K')
      throw new HttpError(400, '分辨率只能是 1K、2K 或 4K');
    const saveTo = agent && typeof body.saveTo === 'string' && body.saveTo ? body.saveTo : '';
    if (saveTo && !isAbsolute(saveTo)) throw new HttpError(400, 'save_to 必须是绝对路径');
    const site = resolveSite(loadConfig(), typeof body.site === 'string' ? body.site : undefined);
    const model =
      (typeof body.model === 'string' && body.model) || site.defaultModel || site.models[0];
    if (!model) throw new HttpError(409, `站点 ${site.name} 还没有配置模型，请在画布设置中添加`);
    if (!safeModel.test(model)) throw new HttpError(400, '模型名无效');
    const board =
      typeof body.boardId === 'string' && body.boardId ? store.get(body.boardId) : store.current();
    const { ids, refs } = references(board, body.references, agent);

    const marks = Array.from({ length: count }, () => {
      const mark = {
        id: `p${++pendingSeq}`,
        boardId: board.id,
        prompt: prompt.slice(0, 200),
        model,
        startedAt: Date.now(),
      };
      pending.set(mark.id, mark);
      return mark;
    });
    emit(board.id);
    inFlight++;
    const images: Array<Record<string, unknown>> = [],
      errors: HttpError[] = [];
    try {
      // The request is deliberately not tied to the caller: a result that was paid for is kept
      // on the canvas even if the tab closes or the agent cancels.
      const settled = await Promise.allSettled(
        marks.map((mark) =>
          generateImage(
            site,
            { model, prompt, aspectRatio, resolution, references: refs },
            shutdown.signal,
          ).finally(() => pending.delete(mark.id)),
        ),
      );
      for (const result of settled) {
        if (result.status === 'rejected') {
          const error = result.reason;
          errors.push(
            error instanceof HttpError ? error : new HttpError(502, '生成失败，未自动重试'),
          );
          continue;
        }
        const image = store.add(
          board,
          result.value.bytes,
          {
            kind: 'generated',
            source: agent ? 'agent' : 'canvas',
            prompt,
            model,
            site: site.name,
          },
          { parents: ids },
        );
        const path = store.imagePath(board, image);
        images.push({
          id: image.id,
          path,
          ...(saveTo ? { savedTo: exportCopy(board, image, saveTo, images.length) } : {}),
          width: image.width,
          height: image.height,
          mime: image.mime,
        });
      }
    } finally {
      for (const mark of marks) pending.delete(mark.id);
      inFlight--;
      lastActivity = Date.now();
      emit(board.id);
    }
    if (!images.length) throw errors[0];
    return {
      board: { id: board.id, title: board.title },
      model,
      site: site.name,
      protocol: protocolFor(site, model),
      images,
      errors: errors.map((e) => e.message),
    };
  }

  function serveStatic(pathname: string, response: ServerResponse) {
    let file = normalize(join(webDir, decodeURIComponent(pathname)));
    if (file !== webDir && !file.startsWith(webDir + sep)) file = join(webDir, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) file = join(webDir, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('画布页面尚未构建，请先运行 pnpm build');
      return;
    }
    const hashed = file.includes(`${sep}assets${sep}`);
    response.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    response.end(readFileSync(file));
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    const method = request.method || 'GET';
    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    // A fixed Host allowlist defeats DNS rebinding; the Origin check stops other sites' pages
    // from driving this server through the user's browser.
    if (!origins.includes(`http://${request.headers.host}`)) throw new HttpError(403, '拒绝访问');
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin && !origins.includes(origin)) throw new HttpError(403, '拒绝访问');
    }
    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持的方法');
      return serveStatic(url.pathname, response);
    }
    const path = url.pathname.slice(5).split('/').map(decodeURIComponent);
    const is = (m: string, ...parts: Array<string | null>) =>
      method === m && path.length === parts.length && parts.every((p, i) => p === null || p === path[i]);

    if (is('GET', 'health'))
      return send(response, 200, {
        ok: true,
        app: 'hrouter-canvas',
        version: VERSION,
        viewers: viewers.size,
      });
    if (is('POST', 'auth')) {
      const body = await readJson(request);
      if (typeof body.token !== 'string' || !same(body.token, token))
        throw new HttpError(401, '访问令牌无效，请从 agent 中重新打开画布');
      return send(
        response,
        200,
        { ok: true },
        { 'Set-Cookie': `hc_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` },
      );
    }
    const agent = same(request.headers.authorization || '', `Bearer ${token}`);
    const viewer = (request.headers.cookie || '')
      .split(';')
      .some((part) => same(part.trim(), `hc_session=${cookie}`));
    if (!agent && !viewer) throw new HttpError(401, '需要从 agent 中打开画布以完成授权');
    lastActivity = Date.now();

    if (is('GET', 'events')) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      response.write('event: hello\ndata: {}\n\n');
      viewers.add(response);
      const beat = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
      response.on('close', () => {
        clearInterval(beat);
        viewers.delete(response);
        lastActivity = Date.now();
      });
      return;
    }
    if (is('GET', 'state')) {
      const config = loadConfig();
      return send(response, 200, {
        version: VERSION,
        sites: config.sites.map(publicSite),
        defaultSite: config.defaultSite || null,
        current: store.current().id,
        boards: store.list(),
      });
    }
    if (is('POST', 'generate')) return send(response, 200, await generate(await readJson(request), agent));
    if (is('POST', 'shutdown')) {
      if (!agent) throw new HttpError(403, '拒绝访问');
      send(response, 200, { ok: true });
      setTimeout(() => void close().then(() => process.exit(0)), 50);
      return;
    }

    if (is('POST', 'boards')) {
      const body = await readJson(request);
      const board = store.create(typeof body.title === 'string' ? body.title : undefined);
      emit();
      return send(response, 200, board);
    }
    if (path[0] === 'boards' && path[1]) {
      const board = store.get(path[1]);
      if (is('GET', 'boards', null))
        return send(response, 200, {
          ...board,
          pending: [...pending.values()].filter((p) => p.boardId === board.id),
        });
      if (is('POST', 'boards', null, 'select')) {
        store.select(board.id);
        emit();
        return send(response, 200, { ok: true });
      }
      if (is('PATCH', 'boards', null)) {
        const body = await readJson(request);
        store.patch(board, body);
        // Panning and zooming are per-tab; echoing them would make other tabs refetch for nothing.
        if (Object.keys(body).some((key) => key !== 'viewport')) emit(board.id);
        return send(response, 200, { ok: true });
      }
      if (is('DELETE', 'boards', null)) {
        store.remove(board.id);
        emit();
        return send(response, 200, { ok: true });
      }
      if (is('POST', 'boards', null, 'import')) {
        const x = Number(url.searchParams.get('x')),
          y = Number(url.searchParams.get('y'));
        let image: CanvasImage;
        try {
          image = store.add(
            board,
            await readBody(request, MAX_IMPORT_BYTES),
            { kind: 'import', source: 'canvas', prompt: '', model: '', site: '' },
            url.searchParams.has('x') && Number.isFinite(x) && Number.isFinite(y)
              ? { at: { x, y } }
              : {},
          );
        } catch (error) {
          throw error instanceof HttpError ? error : new HttpError(400, (error as Error).message);
        }
        emit(board.id);
        return send(response, 200, image);
      }
      if (path[2] === 'images' && path[3]) {
        if (is('GET', 'boards', null, 'images', null)) {
          const { image, bytes } = store.read(board, path[3]);
          response.writeHead(200, {
            'Content-Type': image.mime,
            'Content-Length': bytes.byteLength,
            'Cache-Control': 'private, max-age=31536000, immutable',
            ...(url.searchParams.has('download')
              ? { 'Content-Disposition': `attachment; filename="canvas-${image.file}"` }
              : {}),
          });
          return response.end(bytes);
        }
        if (is('DELETE', 'boards', null, 'images', null)) {
          store.removeImage(board, path[3]);
          emit(board.id);
          return send(response, 200, { ok: true });
        }
      }
    }

    if (path[0] === 'sites' && path[1]) {
      const config = loadConfig();
      const current = config.sites.find((s) => s.id === path[1]);
      if (is('PUT', 'sites', null)) {
        const site = normalizeSite({ ...(await readJson(request)), id: path[1] }, current?.apiKey);
        const sites = current
          ? config.sites.map((s) => (s.id === site.id ? site : s))
          : [...config.sites, site];
        saveConfig({ sites, defaultSite: config.defaultSite || site.id });
        emit();
        return send(response, 200, publicSite(site));
      }
      if (!current) throw new HttpError(404, '站点不存在');
      if (is('DELETE', 'sites', null)) {
        const sites = config.sites.filter((s) => s.id !== current.id);
        saveConfig({
          sites,
          defaultSite: config.defaultSite === current.id ? sites[0]?.id : config.defaultSite,
        });
        emit();
        return send(response, 200, { ok: true });
      }
      if (is('POST', 'sites', null, 'default')) {
        saveConfig({ ...config, defaultSite: current.id });
        emit();
        return send(response, 200, { ok: true });
      }
      if (is('POST', 'sites', null, 'models')) {
        if (!current.apiKey) throw new HttpError(409, '请先填写并保存 API Key');
        return send(response, 200, await listModels(current, shutdown.signal));
      }
    }
    throw new HttpError(404, '接口不存在');
  }

  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', CSP);
    route(request, response).catch((error) => {
      if (response.headersSent) return response.destroy();
      const known = error instanceof HttpError;
      if (!known) console.error(new Date().toISOString(), error);
      send(response, known ? error.status : 500, {
        error: known ? error.message : '画布服务内部错误',
      });
    });
  });
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5000;

  const first = options.port ?? (Number(process.env.HROUTER_CANVAS_PORT) || DEFAULT_PORT);
  for (let candidate = first; ; candidate++) {
    const result = await new Promise<'ok' | 'busy'>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? resolve('busy') : reject(error);
      server.once('error', failed);
      server.listen(candidate, '127.0.0.1', () => {
        server.off('error', failed);
        resolve('ok');
      });
    });
    if (result === 'ok') {
      port = (server.address() as { port: number }).port;
      break;
    }
    if (await probe(candidate)) throw new AlreadyRunning();
    if (candidate - first >= 9) throw new Error(`端口 ${first}–${candidate} 均被占用`);
  }
  writePrivate(daemonFile(), JSON.stringify({ pid: process.pid, port, version: VERSION }) + '\n');

  const idleMs =
    (options.idleMinutes ?? (Number(process.env.HROUTER_CANVAS_IDLE_MINUTES) || 30)) * 60_000;
  const idle = setInterval(() => {
    if (!viewers.size && !inFlight && Date.now() - lastActivity > idleMs)
      void close().then(() => process.exit(0));
  }, 30_000);
  idle.unref();

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return (closing ??= new Promise((resolve) => {
      clearInterval(idle);
      shutdown.abort();
      for (const viewer of viewers) viewer.end();
      try {
        if (JSON.parse(readFileSync(daemonFile(), 'utf8')).pid === process.pid)
          rmSync(daemonFile(), { force: true });
      } catch {
        // Already gone.
      }
      server.close(() => resolve());
      server.closeAllConnections();
    }));
  }
  return { port, url: `http://127.0.0.1:${port}/`, close };
}
