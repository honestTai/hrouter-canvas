import { HttpError, type VideoSite as Site } from './config.ts';
import { inspectVideo, MAX_GENERATED_VIDEO_BYTES, type AspectRatio, type VideoInfo } from './image.ts';
import {
  authHeaders,
  json,
  limitedBody,
  openaiRoot,
  request,
  upstreamError,
  type Reference,
} from './providers.ts';

export interface VideoInput {
  model: string;
  prompt: string;
  // The first frame. It may come from a different site and model than the video.
  image?: Reference & { width: number; height: number };
  duration?: number;
  resolution?: string;
  aspectRatio?: AspectRatio;
}
export interface GeneratedVideo extends VideoInfo {
  bytes: Uint8Array;
}

// `xai` is the async task API HRouter documents (/v1/videos/generations); `openai` is /v1/videos.
export const videoProtocolFor = (site: Site, model: string): 'xai' | 'openai' =>
  site.protocol === 'auto' ? (/^sora-/i.test(model) ? 'openai' : 'xai') : site.protocol;

const MAX_WAIT_MS = 30 * 60_000;
const MAX_POLL_FAILURES = 6;
const pollMs = () => Number(process.env.HROUTER_CANVAS_VIDEO_POLL_MS) || 10_000;
const DONE = new Set(['done', 'completed', 'succeeded', 'success']);
const FAILED = new Set(['failed', 'expired', 'error', 'cancelled', 'canceled']);

const sleep = (ms: number, signal: AbortSignal) =>
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

const dataUrl = (ref: Reference) => `data:${ref.mime};base64,${Buffer.from(ref.bytes).toString('base64')}`;
const taskId = (value: unknown) => {
  if (typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value)) return value;
  throw new HttpError(502, '站点没有返回有效的视频任务 ID');
};
const detail = (value: any) => {
  const raw = value?.error?.message || value?.error || value?.message || value?.fail_reason || '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
};

// HRouter keys belong to groups, and only some groups may make videos. Say so plainly instead of
// the generic "endpoint or model not found".
async function submitError(response: Response): Promise<HttpError> {
  const error = await upstreamError(response);
  if (/not supported for this platform|not enabled for this group/i.test(error.message))
    return new HttpError(
      403,
      `这个站点的 Key 不能生视频（${error.message.replace(/^[^：]*：/, '')}）。HRouter 需要 grok 分组的 Key，请在画布设置的“生视频站点”中填写`,
    );
  return error;
}

class Transient extends Error {}
// Status reads are free and idempotent, so brief outages are waited out. Submitting is never
// repeated: a second submission could be billed as a second video.
async function status(url: string, site: Site, signal: AbortSignal): Promise<any> {
  let response: Response;
  try {
    response = await request(url, { headers: authHeaders(site, 'openai') }, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Transient((error as Error).message);
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (response.status >= 500 || response.status === 429)
    throw new Transient((await upstreamError(response)).message);
  if (!response.ok) throw await upstreamError(response);
  return json(response, '查询视频任务', signal);
}

async function waitFor<T>(
  id: string,
  signal: AbortSignal,
  check: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (let failures = 0; ; ) {
    await sleep(pollMs(), signal);
    try {
      const done = await check();
      failures = 0;
      if (done !== undefined) return done;
    } catch (error) {
      if (!(error instanceof Transient)) throw error;
      if (++failures >= MAX_POLL_FAILURES)
        throw new HttpError(502, `查询视频任务 ${id} 连续失败：${error.message}；任务可能仍在生成，未重新提交`);
    }
    if (Date.now() > deadline)
      throw new HttpError(504, `等待视频超过 30 分钟，任务 ${id} 可能仍在生成，未重新提交`);
  }
}

function settle(value: any, id: string): boolean {
  const state = String(value?.status || '').toLowerCase();
  if (DONE.has(state) || (!state && typeof value?.video?.url === 'string')) return true;
  if (FAILED.has(state)) {
    const why = detail(value);
    throw new HttpError(
      422,
      `视频生成${state === 'expired' ? '已过期' : '失败'}（任务 ${id}）${why ? `：${why}` : ''}`,
    );
  }
  return false;
}

async function save(response: Response, signal: AbortSignal, input: VideoInput): Promise<GeneratedVideo> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(502, `下载生成视频失败（HTTP ${response.status}）`);
  }
  const bytes = await limitedBody(response, MAX_GENERATED_VIDEO_BYTES, '下载生成视频', signal);
  try {
    return { bytes, ...inspectVideo(bytes, input.image) };
  } catch {
    throw new HttpError(502, '站点返回的不是有效的 MP4 视频');
  }
}

// A result link is fetched without the API key, and only over https or from the site itself.
async function downloadUrl(site: Site, value: unknown, signal: AbortSignal, input: VideoInput) {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new HttpError(502, '站点没有返回可下载的视频地址');
  }
  if (url.protocol !== 'https:' && url.origin !== new URL(site.baseUrl).origin)
    throw new HttpError(502, '站点返回了非 https 的视频地址，已拒绝下载');
  return save(await request(url.toString(), { headers: { Accept: 'video/*' } }, signal), signal, input);
}

async function generateXai(site: Site, input: VideoInput, signal: AbortSignal): Promise<GeneratedVideo> {
  const root = openaiRoot(site.baseUrl);
  const headers = authHeaders(site, 'openai');
  headers.set('Content-Type', 'application/json');
  const submitted = await request(
    `${root}/videos/generations`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        ...(input.duration ? { duration: input.duration } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        // With a first frame the video follows the image's shape.
        ...(input.aspectRatio && !input.image ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.image ? { image: { url: dataUrl(input.image) } } : {}),
      }),
    },
    signal,
  );
  if (!submitted.ok) throw await submitError(submitted);
  const task = await json(submitted, '提交视频任务', signal);
  const id = taskId(task?.request_id ?? task?.id);
  // HRouter serves status under /videos/generations/{id} and bills when it reports done; xAI's
  // own API uses /videos/{id}. Try HRouter's path first.
  let base = `${root}/videos/generations/${encodeURIComponent(id)}`;
  let hrouterPath = true;
  const done = await waitFor(id, signal, async () => {
    let value = await status(base, site, signal);
    if (value === undefined && hrouterPath) {
      hrouterPath = false;
      base = `${root}/videos/${encodeURIComponent(id)}`;
      value = await status(base, site, signal);
    }
    if (value === undefined) throw new HttpError(502, `站点找不到视频任务 ${id}`);
    return settle(value, id) ? value : undefined;
  });
  if (hrouterPath) {
    const content = await request(`${base}/content`, { headers: authHeaders(site, 'openai') }, signal);
    if (content.status !== 404 || typeof done?.video?.url !== 'string') return save(content, signal, input);
    await content.body?.cancel().catch(() => {});
  }
  return downloadUrl(site, done?.video?.url, signal, input);
}

// /v1/videos takes a pixel size; derive one only when both resolution and orientation are known.
function openaiSize(input: VideoInput): string | undefined {
  const short = Number(/^(\d{3,4})p$/.exec(input.resolution || '')?.[1]);
  const [w, h] = input.image
    ? [input.image.width, input.image.height]
    : input.aspectRatio
      ? input.aspectRatio.split(':').map(Number)
      : [0, 0];
  if (!short || !w || !h) return undefined;
  const long = Math.round((short * 16) / 9);
  return w >= h ? `${long}x${short}` : `${short}x${long}`;
}

async function generateOpenAI(site: Site, input: VideoInput, signal: AbortSignal): Promise<GeneratedVideo> {
  const root = openaiRoot(site.baseUrl);
  const form = new FormData();
  form.set('model', input.model);
  form.set('prompt', input.prompt);
  if (input.duration) form.set('seconds', String(input.duration));
  const size = openaiSize(input);
  if (size) form.set('size', size);
  if (input.image)
    form.set(
      'input_reference',
      new Blob([input.image.bytes as Uint8Array<ArrayBuffer>], { type: input.image.mime }),
      `reference.${input.image.mime.split('/')[1]}`,
    );
  const submitted = await request(
    `${root}/videos`,
    { method: 'POST', headers: authHeaders(site, 'openai'), body: form },
    signal,
  );
  if (!submitted.ok) throw await submitError(submitted);
  const id = taskId((await json(submitted, '提交视频任务', signal))?.id);
  const base = `${root}/videos/${encodeURIComponent(id)}`;
  await waitFor(id, signal, async () => {
    const value = await status(base, site, signal);
    if (value === undefined) throw new HttpError(502, `站点找不到视频任务 ${id}`);
    return settle(value, id) ? true : undefined;
  });
  return save(
    await request(`${base}/content`, { headers: authHeaders(site, 'openai') }, signal),
    signal,
    input,
  );
}

export function generateVideo(
  site: Site,
  input: VideoInput,
  signal: AbortSignal,
): Promise<GeneratedVideo> {
  return videoProtocolFor(site, input.model) === 'openai'
    ? generateOpenAI(site, input, signal)
    : generateXai(site, input, signal);
}
