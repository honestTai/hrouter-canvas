import { HttpError, type Site } from './config.ts';
import {
  inspectImage,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_GENERATION_RESPONSE_BYTES,
  type AspectRatio,
  type ImageInfo,
} from './image.ts';

export interface Reference {
  bytes: Uint8Array;
  mime: string;
}
export interface GenerationInput {
  model: string;
  prompt: string;
  aspectRatio?: AspectRatio;
  resolution?: '1K' | '2K' | '4K';
  references: Reference[];
  // Animated GIF (gpt-image-2.6 only): text-to-image, 2-16 frames.
  animation?: { frameCount: number; frameDurationMs: number };
}
export interface GeneratedImage extends ImageInfo {
  bytes: Uint8Array;
}

const TIMEOUT_MS = 300_000;
const trimSlash = (value: string) => value.replace(/\/+$/, '');
// Users paste either the site root or a versioned API root; both must work.
export const openaiRoot = (baseUrl: string) =>
  /\/v\d+$/.test(trimSlash(baseUrl)) ? trimSlash(baseUrl) : `${trimSlash(baseUrl)}/v1`;
export const geminiRoot = (baseUrl: string) =>
  `${trimSlash(baseUrl).replace(/\/v\d+(beta)?$/, '')}/v1beta`;
export const protocolFor = (site: Site, model: string): 'openai' | 'gemini' =>
  site.protocol === 'auto' ? (/^gemini-/i.test(model) ? 'gemini' : 'openai') : site.protocol;

// Google's own endpoint treats a Bearer value as an OAuth token; relays usually expect Bearer.
export function authHeaders(
  site: Pick<Site, 'apiKey' | 'baseUrl'>,
  protocol: 'openai' | 'gemini',
): Headers {
  const headers = new Headers();
  if (protocol === 'gemini') headers.set('x-goog-api-key', site.apiKey);
  if (protocol === 'openai' || !/(^|\.)googleapis\.com$/.test(new URL(site.baseUrl).hostname))
    headers.set('Authorization', `Bearer ${site.apiKey}`);
  return headers;
}

// fetch resolves once headers arrive. Reading its body can still fail independently.
function bodyReadError(error: unknown, stage: string, signal?: AbortSignal): HttpError {
  if (signal?.aborted) return new HttpError(499, '已取消');
  const failure = error as { name?: string; cause?: { code?: unknown } } | null;
  const rawCode = failure?.cause?.code;
  // Never expose arbitrary exception text: it may contain URLs, credentials or response data.
  const code = typeof rawCode === 'string' && /^(?:UND_ERR_[A-Z_]+|E[A-Z_]+)$/.test(rawCode)
    ? rawCode
    : '';
  const timedOut = failure?.name === 'TimeoutError' || /TIMEOUT|TIMEDOUT/.test(code);
  return new HttpError(
    502,
    `${stage}${timedOut ? '超时' : '时连接中断或数据读取失败'}${code ? `（${code}）` : ''}；服务端可能已完成生成，但本机未收到完整结果，未自动重试`,
  );
}

export async function limitedBody(
  response: Response,
  limit: number,
  stage = '读取站点响应',
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read().catch((error: unknown) => {
      throw bodyReadError(error, stage, signal);
    });
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(502, '站点响应超过安全大小上限');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// The site is the user's own choice, so its error text is shown to help them fix configuration.
export async function upstreamError(response: Response): Promise<HttpError> {
  let detail = '';
  try {
    const text = new TextDecoder().decode(await limitedBody(response, 64 * 1024));
    try {
      const value = JSON.parse(text);
      detail = value?.error?.message || value?.error || value?.message || '';
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch {
      detail = /^\s*</.test(text) ? '' : text;
    }
  } catch {
    // Keep the status-only message.
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  const status = response.status;
  const reason =
    status === 401 || status === 403
      ? 'API Key 无效或没有权限'
      : status === 402 || status === 429
        ? '额度不足或请求过于频繁'
        : status === 404
          ? '接口或模型不存在，请检查站点地址、协议类型和模型名'
          : status === 504 || status === 524
            ? '站点网关等待上游响应超时，服务端可能仍在生成，请勿盲目重试以免重复扣费'
            : '站点返回错误';
  return new HttpError(
    status === 401 || status === 403 ? 403 : status === 402 || status === 429 ? 429 : 502,
    `${reason}（HTTP ${status}）${detail ? `：${detail}` : ''}`,
  );
}

const isEventStream = (response: Response) =>
  /\btext\/event-stream\b/i.test(response.headers.get('content-type') || '');

export interface SseEvent {
  event: string;
  data: string;
}

// Streaming responses send headers and periodic SSE heartbeats early, keeping reverse proxies
// such as Cloudflare (125s Proxy Read Timeout → HTTP 524) alive during slow 4K generations.
export async function* sseEvents(
  response: Response,
  limit: number,
  stage = '读取站点响应',
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let size = 0,
    buffer = '',
    event = '',
    data: string[] = [],
    finished = false;
  const consumeLine = (raw: string): SseEvent | undefined => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) {
      if (!data.length) {
        event = '';
        return undefined;
      }
      const out = { event: event || 'message', data: data.join('\n') };
      event = '';
      data = [];
      return out;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + (line[colon + 1] === ' ' ? 2 : 1));
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return undefined;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read().catch((error: unknown) => {
        throw bodyReadError(error, stage, signal);
      });
      if (done) {
        finished = true;
        buffer += decoder.decode();
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        finished = true;
        throw new HttpError(502, '站点响应超过安全大小上限');
      }
      buffer += decoder.decode(value, { stream: true });
      for (let nl; (nl = buffer.indexOf('\n')) >= 0; ) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const flushed = consumeLine(line);
        if (flushed) yield flushed;
      }
    }
    if (buffer) {
      const flushed = consumeLine(buffer);
      if (flushed) yield flushed;
    }
    const tail = consumeLine('');
    if (tail) yield tail;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function streamError(payload: any): HttpError {
  const raw = payload?.error ?? payload;
  const detail = String(
    (typeof raw === 'string' ? raw : raw?.message || raw?.code || raw?.type || JSON.stringify(raw)) || '',
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  const code = String(raw?.code || raw?.type || raw?.status || '').toLowerCase();
  const numeric = typeof raw?.code === 'number' ? raw.code : 0;
  if (numeric === 401 || numeric === 403 || /auth|invalid_api_key|permission|forbidden/.test(code))
    return new HttpError(403, `API Key 无效或没有权限${detail ? `：${detail}` : ''}`);
  if (numeric === 402 || numeric === 429 || /rate_limit|quota|exhausted|insufficient/.test(code))
    return new HttpError(429, `额度不足或请求过于频繁${detail ? `：${detail}` : ''}`);
  if (/moderation|safety|policy|content_policy|invalid_request|user_error/.test(code))
    return new HttpError(422, `生图请求被拒绝${detail ? `：${detail}` : ''}`);
  return new HttpError(502, `站点流式响应返回错误${detail ? `：${detail}` : ''}；未自动重试`);
}

export async function request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) throw new HttpError(499, '已取消');
    const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
    const name = (error as Error)?.name;
    throw new HttpError(
      502,
      name === 'TimeoutError'
        ? '站点响应超时'
        : `无法连接站点 ${new URL(url).host}${cause?.code ? `（${cause.code}）` : ''}`,
    );
  }
}

function decode(base64: string): GeneratedImage {
  if (base64.length > Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 4)
    throw new HttpError(502, '生成图片超过安全大小上限');
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  try {
    return { bytes, ...inspectImage(bytes) };
  } catch {
    throw new HttpError(502, '站点没有返回有效图片');
  }
}

// Many relays answer with a result URL instead of b64_json. Fetch it, but only over https
// (or from the configured site itself) and only if the bytes really are a bounded image.
async function download(site: Site, value: string, signal: AbortSignal): Promise<GeneratedImage> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(502, '站点返回的图片地址无效');
  }
  if (url.protocol !== 'https:' && url.origin !== new URL(site.baseUrl).origin)
    throw new HttpError(502, '站点返回了非 https 的图片地址，已拒绝下载');
  const response = await request(url.toString(), { headers: { Accept: 'image/*' } }, signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(502, `下载生成图片失败（HTTP ${response.status}）`);
  }
  const bytes = await limitedBody(response, MAX_GENERATED_IMAGE_BYTES, '下载生成图片', signal);
  try {
    return { bytes, ...inspectImage(bytes) };
  } catch {
    throw new HttpError(502, '站点返回的地址不是有效图片');
  }
}

const orientation = (ratio: AspectRatio) => {
  const [w, h] = ratio.split(':').map(Number);
  return w === h ? 'square' : w > h ? 'landscape' : 'portrait';
};
// Exact pixel sizes are only sent for model families whose accepted sizes are known.
function openaiSize(model: string, ratio?: AspectRatio): { size?: string; exact: boolean } {
  const shape = ratio ? orientation(ratio) : undefined;
  if (/^gpt-image-/i.test(model)) {
    const size =
      ratio === '1:1'
        ? '1024x1024'
        : ratio === '3:2'
          ? '1536x1024'
          : ratio === '2:3'
            ? '1024x1536'
            : 'auto';
    return { size, exact: size !== 'auto' };
  }
  if (/^dall-e-3/i.test(model) && shape)
    return {
      size: shape === 'square' ? '1024x1024' : shape === 'landscape' ? '1792x1024' : '1024x1792',
      exact: ratio === '1:1',
    };
  return { exact: false };
}

const asyncUnavailableUntil = new Map<string, number>();
const ASYNC_NEGATIVE_TTL_MS = 60_000;
const ASYNC_IMAGE_MAX_WAIT_MS = 15 * 60_000;
const ASYNC_IMAGE_MAX_POLL_FAILURES = 6;
export const resetAsyncImageCache = () => asyncUnavailableUntil.clear();

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new HttpError(499, '已取消'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new HttpError(499, '已取消'));
    };
    signal.addEventListener('abort', stop, { once: true });
  });

function imagePollMs(retryAfter?: string | null): number {
  const env = Number(process.env.HROUTER_CANVAS_IMAGE_POLL_MS);
  if (env > 0) return env;
  const hinted = Number(retryAfter);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(10_000, Math.max(1000, hinted * 1000));
  return 3000;
}

async function resolveImageItem(
  site: Site,
  item: { b64_json?: unknown; url?: unknown } | undefined,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  if (typeof item?.b64_json === 'string' && item.b64_json) return decode(item.b64_json);
  if (typeof item?.url === 'string' && item.url) {
    const data = /^data:image\/(?:png|jpeg|webp|gif);base64,(.+)$/s.exec(item.url);
    return data ? decode(data[1]) : download(site, item.url, signal);
  }
  throw new HttpError(502, '站点没有返回图片（响应中既没有 b64_json 也没有 url）');
}

function asyncTaskFailure(polled: any, id: string): HttpError {
  const status = Number(polled?.http_status) || 502;
  const raw = polled?.error;
  const detail = String(
    (typeof raw === 'string' ? raw : raw?.message || raw?.code || raw?.type || '') || '',
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (status === 401 || status === 403)
    return new HttpError(403, `API Key 无效或没有权限（任务 ${id}）${detail ? `：${detail}` : ''}`);
  if (status === 402 || status === 429)
    return new HttpError(429, `额度不足或请求过于频繁（任务 ${id}）${detail ? `：${detail}` : ''}`);
  if (status === 400 || status === 422)
    return new HttpError(422, `生图请求被拒绝（任务 ${id}）${detail ? `：${detail}` : ''}`);
  return new HttpError(502, `生图任务失败（任务 ${id}，HTTP ${status}）${detail ? `：${detail}` : ''}；未自动重试`);
}

async function pollOpenAIImageTask(
  site: Site,
  root: string,
  initial: any,
  initialRetryAfter: string | null,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  const rawId = initial?.task_id ?? initial?.id;
  if (typeof rawId !== 'string' || !/^[\w.:-]{1,200}$/.test(rawId))
    throw new HttpError(502, '站点没有返回有效的异步生图任务 ID');
  const settle = (value: any): { b64_json?: unknown; url?: unknown } | undefined => {
    const state = String(value?.status || '').toLowerCase();
    if (state === 'completed' || state === 'succeeded' || state === 'done')
      return value?.result?.data?.[0] ?? (typeof value?.image_url === 'string' ? { url: value.image_url } : undefined);
    if (state === 'failed' || state === 'error' || state === 'expired' || state === 'cancelled' || state === 'canceled')
      throw asyncTaskFailure(value, rawId);
    return undefined;
  };
  const immediate = settle(initial);
  if (immediate !== undefined) return resolveImageItem(site, immediate, signal);

  const pollUrl = `${root}/images/tasks/${encodeURIComponent(rawId)}`;
  const deadline = Date.now() + ASYNC_IMAGE_MAX_WAIT_MS;
  let retryAfter = initialRetryAfter,
    failures = 0;
  for (;;) {
    await abortableSleep(imagePollMs(retryAfter), signal);
    let resp: Response;
    try {
      resp = await request(pollUrl, { headers: authHeaders(site, 'openai') }, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (++failures >= ASYNC_IMAGE_MAX_POLL_FAILURES)
        throw new HttpError(502, `查询生图任务 ${rawId} 连续失败：${(error as Error).message}；任务可能仍在生成，未重新提交`);
      continue;
    }
    if (resp.status >= 500 || resp.status === 429) {
      const err = await upstreamError(resp);
      if (++failures >= ASYNC_IMAGE_MAX_POLL_FAILURES)
        throw new HttpError(502, `查询生图任务 ${rawId} 连续失败：${err.message}；任务可能仍在生成，未重新提交`);
      continue;
    }
    if (!resp.ok) throw await upstreamError(resp);
    retryAfter = resp.headers.get('retry-after');
    const current = await json(resp, '查询生图任务', signal);
    failures = 0;
    const done = settle(current);
    if (done !== undefined) return resolveImageItem(site, done, signal);
    if (Date.now() > deadline)
      throw new HttpError(504, `等待生图任务 ${rawId} 超过 15 分钟，任务可能仍在后台生成，未重新提交`);
  }
}

async function generateOpenAI(
  site: Site,
  input: GenerationInput,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  if (input.animation && !/^gpt-image-2\.6-/i.test(input.model))
    throw new HttpError(400, 'GIF 动图目前只有 gpt-image-2.6-flare / gpt-image-2.6-sunburst 支持');
  if (input.animation && input.references.length)
    throw new HttpError(400, 'GIF 动图只能文生图，不能带参考图');
  const { size, exact } = openaiSize(input.model, input.aspectRatio);
  const prompt =
    input.aspectRatio && !exact
      ? `[Aspect ratio ${input.aspectRatio}, ${orientation(input.aspectRatio)} composition]\n\n${input.prompt}`
      : input.prompt;
  const root = openaiRoot(site.baseUrl);
  // GPT image models support SSE streaming on both /images/generations and /images/edits, while
  // sub2api also offers /images/{generations,edits}/async task polling that avoids holding any
  // CDN connection open during multi-minute upstream header waits (e.g. Codex /images/edits).
  const streamable = /^gpt-image-/i.test(input.model) && !input.animation;
  const send = (stream: boolean, asyncSuffix = false) => {
    const headers = authHeaders(site, 'openai');
    if (stream) headers.set('Accept', 'text/event-stream, application/json');
    let path: string, body: string | FormData;
    if (input.references.length) {
      path = '/images/edits';
      const form = new FormData();
      form.set('model', input.model);
      form.set('prompt', prompt);
      form.set('n', '1');
      if (size) form.set('size', size);
      if (stream) form.set('stream', 'true');
      input.references.forEach((ref, i) =>
        form.append(
          'image[]',
          new Blob([ref.bytes as Uint8Array<ArrayBuffer>], { type: ref.mime }),
          `reference-${i}.${ref.mime.split('/')[1]}`,
        ),
      );
      body = form;
    } else {
      path = '/images/generations';
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify({
        model: input.model,
        prompt,
        n: 1,
        ...(size ? { size } : {}),
        ...(stream ? { stream: true } : {}),
        ...(input.animation
          ? {
              output_format: 'gif',
              frame_count: input.animation.frameCount,
              frame_duration_ms: input.animation.frameDurationMs,
            }
          : {}),
      });
    }
    return request(`${root}${path}${asyncSuffix ? '/async' : ''}`, { method: 'POST', headers, body }, signal);
  };

  if ((asyncUnavailableUntil.get(root) || 0) <= Date.now()) {
    const submitted = await send(false, true);
    if (submitted.ok) {
      if (!isEventStream(submitted)) {
        const value = await json(submitted, '读取生图接口响应', signal);
        if (Array.isArray(value?.data)) return resolveImageItem(site, value.data[0], signal);
        return pollOpenAIImageTask(site, root, value, submitted.headers.get('retry-after'), signal);
      }
      // If a custom proxy returned SSE on /async, read it via the standard stream path below.
      let first: { b64_json?: unknown; url?: unknown } | undefined;
      for await (const { event, data } of sseEvents(submitted, MAX_GENERATION_RESPONSE_BYTES, '读取生图接口响应', signal)) {
        const trimmed = data.trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        const payload = JSON.parse(trimmed);
        if (event === 'error' || payload?.type === 'error' || payload?.error) throw streamError(payload);
        if (Array.isArray(payload?.data) && payload.data[0]) first = payload.data[0];
        else if ((typeof payload?.b64_json === 'string' || typeof payload?.url === 'string') && !String(payload?.type || '').includes('partial'))
          first = payload;
      }
      return resolveImageItem(site, first, signal);
    }
    const asyncErr = await upstreamError(submitted);
    const notEnabled =
      ((submitted.status === 404 || submitted.status === 405 || submitted.status === 501) &&
        !/not supported for this platform/i.test(asyncErr.message)) ||
      (submitted.status === 503 && /image task storage is unavailable|IMAGE_TASK_UNAVAILABLE/i.test(asyncErr.message));
    if (!notEnabled) throw asyncErr;
    asyncUnavailableUntil.set(root, Date.now() + ASYNC_NEGATIVE_TTL_MS);
  }

  let response = await send(streamable);
  if (!response.ok) {
    const error = await upstreamError(response);
    // Older OpenAI-compatible relays may reject `stream` during parameter validation before running.
    if (
      streamable &&
      response.status === 400 &&
      /(?:unknown|unsupported|invalid|unexpected|unrecognized)\s+(?:parameter|field|argument|option)[^a-z0-9]{0,16}stream\b|\bstream\b[^.:\n]{0,24}(?:not supported|is invalid|unrecognized|not allowed|not permitted)/i.test(
        error.message,
      )
    ) {
      response = await send(false);
      if (!response.ok) throw await upstreamError(response);
    } else {
      throw error;
    }
  }
  let first: { b64_json?: unknown; url?: unknown } | undefined;
  if (isEventStream(response)) {
    let nonPartial: { b64_json?: unknown; url?: unknown } | undefined;
    for await (const { event, data } of sseEvents(
      response,
      MAX_GENERATION_RESPONSE_BYTES,
      '读取生图接口响应',
      signal,
    )) {
      const trimmed = data.trim();
      if (!trimmed || trimmed === '[DONE]') continue;
      let payload: any;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        throw new HttpError(502, '站点返回的流式生图数据不是有效 JSON；未自动重试');
      }
      const type = String(payload?.type || event || '');
      if (event === 'error' || type === 'error' || payload?.error) throw streamError(payload);
      if (Array.isArray(payload?.data) && payload.data[0]) {
        first = payload.data[0];
        continue;
      }
      if (typeof payload?.b64_json === 'string' || typeof payload?.url === 'string') {
        if (type.endsWith('.completed')) first = payload;
        else if (!type.includes('partial')) nonPartial = payload;
      }
    }
    first ??= nonPartial;
  } else {
    first = (await json(response, '读取生图接口响应', signal))?.data?.[0];
  }
  return resolveImageItem(site, first, signal);
}

async function generateGemini(
  site: Site,
  input: GenerationInput,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  const imageConfig = {
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.resolution ? { imageSize: input.resolution } : {}),
  };
  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          { text: input.prompt },
          ...input.references.map((ref) => ({
            inlineData: { mimeType: ref.mime, data: Buffer.from(ref.bytes).toString('base64') },
          })),
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
    },
  });
  const base = `${geminiRoot(site.baseUrl)}/models/${encodeURIComponent(input.model)}`;
  const send = (stream: boolean) => {
    const headers = authHeaders(site, 'gemini');
    headers.set('Content-Type', 'application/json');
    if (stream) headers.set('Accept', 'text/event-stream, application/json');
    return request(
      stream ? `${base}:streamGenerateContent?alt=sse` : `${base}:generateContent`,
      { method: 'POST', headers, body },
      signal,
    );
  };
  let response = await send(true);
  // Relays that only mount :generateContent reject :streamGenerateContent before running.
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel().catch(() => {});
    response = await send(false);
  }
  if (!response.ok) throw await upstreamError(response);
  let finalImage = '',
    thoughtImage = '',
    said = '';
  const collect = (value: any) => {
    if (value?.error) throw streamError(value);
    const envelope = value?.response?.candidates ? value.response : value;
    for (const candidate of envelope?.candidates || [])
      for (const part of candidate?.content?.parts || []) {
        const image = part?.inlineData || part?.inline_data;
        if (typeof image?.data === 'string' && image.data) {
          if (part?.thought) thoughtImage = image.data;
          else finalImage = image.data;
        } else if (typeof part?.text === 'string' && !part?.thought) {
          said += part.text;
        }
      }
  };
  if (isEventStream(response)) {
    for await (const { event, data } of sseEvents(
      response,
      MAX_GENERATION_RESPONSE_BYTES,
      '读取生图接口响应',
      signal,
    )) {
      const trimmed = data.trim();
      if (!trimmed || trimmed === '[DONE]') continue;
      let chunk: any;
      try {
        chunk = JSON.parse(trimmed);
      } catch {
        throw new HttpError(502, '站点返回的流式生图数据不是有效 JSON；未自动重试');
      }
      if (event === 'error') throw streamError(chunk);
      collect(chunk);
    }
  } else {
    const value = await json(response, '读取生图接口响应', signal);
    for (const item of Array.isArray(value) ? value : [value]) collect(item);
  }
  const chosen = finalImage || thoughtImage;
  if (chosen) return decode(chosen);
  said = said.replace(/\s+/g, ' ').trim().slice(0, 200);
  throw new HttpError(
    422,
    `模型没有返回图片，可能被安全策略拒绝，请调整提示词${said ? `。模型回复：${said}` : ''}`,
  );
}

export async function json(response: Response, stage = '读取站点响应', signal?: AbortSignal): Promise<any> {
  const bytes = await limitedBody(response, MAX_GENERATION_RESPONSE_BYTES, stage, signal);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(502, '站点返回的不是 JSON，请检查站点地址是否为 API 地址');
  }
}

export function generateImage(
  site: Site,
  input: GenerationInput,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  return protocolFor(site, input.model) === 'gemini'
    ? generateGemini(site, input, signal)
    : generateOpenAI(site, input, signal);
}

const imageLike =
  /image|dall-e|imagen|flux|seedream|seededit|kolors|wanx|cogview|midjourney|stable-diffusion|sdxl|hidream|recraft|ideogram|qwen-image|banana/i;
const videoLike =
  /video|veo|sora|kling|hailuo|seedance|vidu|runway|luma|pika|cogvideo|i2v|t2v/i;
// Lists what the site advertises; `suggested` and `video` are name-based guesses at which ids
// draw images and which make videos.
export async function listModels(
  site: Pick<Site, 'apiKey' | 'baseUrl'> & { protocol: string },
  signal: AbortSignal,
): Promise<{ all: string[]; suggested: string[]; video: string[] }> {
  const gemini = site.protocol === 'gemini';
  const response = await request(
    gemini ? `${geminiRoot(site.baseUrl)}/models?pageSize=1000` : `${openaiRoot(site.baseUrl)}/models`,
    { headers: authHeaders(site, gemini ? 'gemini' : 'openai') },
    AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  );
  if (!response.ok) throw await upstreamError(response);
  const value = await json(response);
  const items: unknown[] = Array.isArray(value?.data)
    ? value.data
    : Array.isArray(value?.models)
      ? value.models
      : [];
  const all = [
    ...new Set(
      items
        .map((item) => {
          const record = item as { id?: unknown; name?: unknown };
          const id = typeof record?.id === 'string' ? record.id : record?.name;
          return typeof id === 'string' ? id.replace(/^models\//, '') : '';
        })
        .filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,119}$/.test(id)),
    ),
  ].sort();
  return {
    all,
    suggested: all.filter((id) => imageLike.test(id) && !videoLike.test(id)),
    video: all.filter((id) => videoLike.test(id)),
  };
}
