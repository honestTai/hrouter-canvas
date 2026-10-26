import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

declare const __VERSION__: string | undefined;
export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
export const DEFAULT_PORT = 17861;
export const home = () => process.env.HROUTER_CANVAS_HOME || join(homedir(), '.hrouter-canvas');

export type Protocol = 'auto' | 'openai' | 'gemini';
export type VideoProtocol = 'auto' | 'xai' | 'openai';
interface Endpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel?: string;
}
export interface Site extends Endpoint {
  protocol: Protocol;
}
export interface VideoSite extends Endpoint {
  protocol: VideoProtocol;
}
// Image and video sites are separate lists with their own keys: a picture made on one site can
// become a video on another, and a key that can draw is often not allowed to make videos.
export interface Config {
  sites: Site[];
  defaultSite?: string;
  videoSites: VideoSite[];
  defaultVideoSite?: string;
}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const preset = (): Site => ({
  id: 'hrouter',
  name: 'HRouter',
  baseUrl: 'https://hrouter.net',
  protocol: 'auto',
  apiKey: '',
  models: ['gpt-image-2', 'gemini-3.1-flash-image'],
});
// HRouter makes videos only with a grok-group key, so its video preset is a site of its own.
const videoPreset = (): VideoSite => ({
  id: 'hrouter-video',
  name: 'HRouter 视频',
  baseUrl: 'https://hrouter.net',
  protocol: 'auto',
  apiKey: '',
  models: ['grok-imagine-video-1.5', 'grok-imagine-video'],
  defaultModel: 'grok-imagine-video-1.5',
});

export function ensureHome(): string {
  const dir = home();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
// Secrets never get a world-readable moment: write a 0600 temp file, then rename over the target.
export function writePrivate(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

const configPath = () => join(home(), 'config.json');
function parseList<T>(value: unknown, normalize: (item: unknown) => T): T[] {
  const list: T[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    try {
      list.push(normalize(item));
    } catch {
      // A hand-edited invalid entry is skipped rather than breaking every other site.
    }
  }
  return list;
}
export function loadConfig(): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {
      sites: [preset()],
      defaultSite: 'hrouter',
      videoSites: [videoPreset()],
      defaultVideoSite: 'hrouter-video',
    };
  }
  const raw = parsed as Record<string, unknown>;
  const sites = parseList(raw.sites, (item) => normalizeSite(item));
  // Configs written before video support start with the HRouter video preset.
  const videoSites = Array.isArray(raw.videoSites)
    ? parseList(raw.videoSites, (item) => normalizeVideoSite(item))
    : [videoPreset()];
  const pickDefault = (list: Endpoint[], wanted: unknown) =>
    list.some((s) => s.id === wanted) ? (wanted as string) : list[0]?.id;
  return {
    sites,
    defaultSite: pickDefault(sites, raw.defaultSite),
    videoSites,
    defaultVideoSite: pickDefault(videoSites, raw.defaultVideoSite),
  };
}
export function saveConfig(config: Config): void {
  ensureHome();
  writePrivate(configPath(), JSON.stringify(config, null, 2) + '\n');
}

const privateHost = (host: string) =>
  host === 'localhost' ||
  host.endsWith('.local') ||
  host.endsWith('.localhost') ||
  /^127\./.test(host) ||
  /^10\./.test(host) ||
  /^192\.168\./.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
  host === '[::1]';

export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, '站点地址无效');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, '站点地址无效，应类似 https://example.com');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new HttpError(400, '站点地址不能包含账号、查询参数或 # 片段');
  // An API Key over plain http is only acceptable to this machine or the local network.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost(url.hostname)))
    throw new HttpError(400, '站点地址必须使用 https（本机或局域网地址可用 http）');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

const safeModel = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,119}$/;
function normalizeEndpoint<P extends string>(
  input: unknown,
  existingKey: string,
  protocols: readonly P[],
): Endpoint & { protocol: P } {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id))
    throw new HttpError(400, '站点 ID 只能包含小写字母、数字和连字符');
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  const protocol = raw.protocol as P;
  if (!protocols.includes(protocol)) throw new HttpError(400, '协议类型无效');
  const models = [
    ...new Set(
      (Array.isArray(raw.models) ? raw.models : []).filter(
        (m): m is string => typeof m === 'string' && safeModel.test(m),
      ),
    ),
  ].slice(0, 100);
  const defaultModel =
    typeof raw.defaultModel === 'string' && models.includes(raw.defaultModel)
      ? raw.defaultModel
      : undefined;
  // An omitted key keeps the stored one, so the settings page never needs to read it back.
  const apiKey = typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey.trim() : existingKey;
  if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new HttpError(400, 'API Key 无效');
  return {
    id,
    name: name || id,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    protocol,
    apiKey,
    models,
    ...(defaultModel ? { defaultModel } : {}),
  };
}
export const normalizeSite = (input: unknown, existingKey = ''): Site =>
  normalizeEndpoint(input, existingKey, ['auto', 'openai', 'gemini'] as const);
export const normalizeVideoSite = (input: unknown, existingKey = ''): VideoSite =>
  normalizeEndpoint(input, existingKey, ['auto', 'xai', 'openai'] as const);
export const publicSite = <T extends { apiKey: string }>({ apiKey, ...site }: T) => ({
  ...site,
  hasKey: !!apiKey,
  keyHint: apiKey.length >= 12 ? `…${apiKey.slice(-4)}` : '',
});

// Headless setups configure sites through the MCP server's environment instead of the page. The
// video site reuses the image site's address and key unless its own are given.
export function applyEnvSite(env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig();
  let next = config;
  const baseUrl = env.HROUTER_CANVAS_BASE_URL,
    apiKey = env.HROUTER_CANVAS_API_KEY;
  if (baseUrl && apiKey) {
    const model = env.HROUTER_CANVAS_MODEL;
    const site = normalizeSite({
      id: 'env',
      name: env.HROUTER_CANVAS_SITE_NAME || '环境变量站点',
      baseUrl,
      protocol: env.HROUTER_CANVAS_PROTOCOL || 'auto',
      apiKey,
      models: model ? [model] : [],
      defaultModel: model,
    });
    next = { ...next, sites: [site, ...next.sites.filter((s) => s.id !== 'env')], defaultSite: 'env' };
  }
  const videoModel = env.HROUTER_CANVAS_VIDEO_MODEL;
  const videoUrl = env.HROUTER_CANVAS_VIDEO_BASE_URL || baseUrl,
    videoKey = env.HROUTER_CANVAS_VIDEO_API_KEY || apiKey;
  if (videoModel && videoUrl && videoKey) {
    const site = normalizeVideoSite({
      id: 'env',
      name: env.HROUTER_CANVAS_VIDEO_SITE_NAME || '环境变量视频站点',
      baseUrl: videoUrl,
      protocol: env.HROUTER_CANVAS_VIDEO_PROTOCOL || 'auto',
      apiKey: videoKey,
      models: [videoModel],
      defaultModel: videoModel,
    });
    next = {
      ...next,
      videoSites: [site, ...next.videoSites.filter((s) => s.id !== 'env')],
      defaultVideoSite: 'env',
    };
  }
  if (JSON.stringify(next) !== JSON.stringify(config)) saveConfig(next);
}

function pick<T extends Endpoint>(
  list: T[],
  fallback: string | undefined,
  wanted: string | undefined,
  kind: string,
  setup: string,
): T {
  if (wanted) {
    const match = list.find((s) => s.id === wanted || s.name.toLowerCase() === wanted.toLowerCase());
    if (!match) throw new HttpError(400, `没有名为 ${wanted} 的${kind}站点`);
    if (!match.apiKey) throw new HttpError(409, `站点 ${match.name} 还没有填写 API Key`);
    return match;
  }
  const usable = list.filter((s) => s.apiKey);
  const site = usable.find((s) => s.id === fallback) || usable[0];
  if (!site) throw new HttpError(409, setup);
  return site;
}
export const resolveSite = (config: Config, wanted?: string): Site =>
  pick(config.sites, config.defaultSite, wanted, '生图', '还没有配置可用的生图站点，请先在画布设置中填写站点地址和 API Key');
export const resolveVideoSite = (config: Config, wanted?: string): VideoSite =>
  pick(
    config.videoSites,
    config.defaultVideoSite,
    wanted,
    '生视频',
    '还没有配置可用的生视频站点，请在画布设置的“生视频站点”中填写 API Key（HRouter 需要 grok 分组的 Key）',
  );

// No browser can be opened here: the user asked for none, or this is a remote or CI session.
export const headless = (env: NodeJS.ProcessEnv = process.env) =>
  env.HROUTER_CANVAS_OPEN === 'never' ||
  !!env.SSH_CONNECTION ||
  !!env.SSH_TTY ||
  !!env.CI ||
  (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY);

export function secret(): string {
  const path = join(ensureHome(), 'secret');
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(value)) return value;
  }
  const value = randomBytes(32).toString('hex');
  writePrivate(path, value + '\n');
  return value;
}
