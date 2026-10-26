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
          : '站点返回错误';
  return new HttpError(
    status === 401 || status === 403 ? 403 : status === 402 || status === 429 ? 429 : 502,
    `${reason}（HTTP ${status}）${detail ? `：${detail}` : ''}`,
  );
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

async function generateOpenAI(
  site: Site,
  input: GenerationInput,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  const { size, exact } = openaiSize(input.model, input.aspectRatio);
  const prompt =
    input.aspectRatio && !exact
      ? `[Aspect ratio ${input.aspectRatio}, ${orientation(input.aspectRatio)} composition]\n\n${input.prompt}`
      : input.prompt;
  const headers = authHeaders(site, 'openai');
  let path: string, body: string | FormData;
  if (input.references.length) {
    path = '/images/edits';
    const form = new FormData();
    form.set('model', input.model);
    form.set('prompt', prompt);
    form.set('n', '1');
    if (size) form.set('size', size);
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
    body = JSON.stringify({ model: input.model, prompt, n: 1, ...(size ? { size } : {}) });
  }
  const response = await request(
    openaiRoot(site.baseUrl) + path,
    { method: 'POST', headers, body },
    signal,
  );
  if (!response.ok) throw await upstreamError(response);
  const first = (await json(response, '读取生图接口响应', signal))?.data?.[0];
  if (typeof first?.b64_json === 'string' && first.b64_json) return decode(first.b64_json);
  if (typeof first?.url === 'string') {
    const data = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/s.exec(first.url);
    return data ? decode(data[1]) : download(site, first.url, signal);
  }
  throw new HttpError(502, '站点没有返回图片（响应中既没有 b64_json 也没有 url）');
}

async function generateGemini(
  site: Site,
  input: GenerationInput,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  const headers = authHeaders(site, 'gemini');
  headers.set('Content-Type', 'application/json');
  const imageConfig = {
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.resolution ? { imageSize: input.resolution } : {}),
  };
  const response = await request(
    `${geminiRoot(site.baseUrl)}/models/${encodeURIComponent(input.model)}:generateContent`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
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
      }),
    },
    signal,
  );
  if (!response.ok) throw await upstreamError(response);
  const value = await json(response, '读取生图接口响应', signal);
  let said = '';
  for (const candidate of value?.candidates || [])
    for (const part of candidate?.content?.parts || []) {
      const image = part?.inlineData || part?.inline_data;
      if (typeof image?.data === 'string' && image.data) return decode(image.data);
      if (typeof part?.text === 'string') said += part.text;
    }
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
