import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

declare const __VERSION__: string | undefined;
export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
export const DEFAULT_PORT = 17861;
export const home = () => process.env.HROUTER_CANVAS_HOME || join(homedir(), '.hrouter-canvas');

export type Protocol = 'auto' | 'openai' | 'gemini';
export interface Site {
  id: string;
  name: string;
  baseUrl: string;
  protocol: Protocol;
  apiKey: string;
  models: string[];
  defaultModel?: string;
}
export interface Config {
  sites: Site[];
  defaultSite?: string;
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
export function loadConfig(): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return { sites: [preset()], defaultSite: 'hrouter' };
  }
  const raw = parsed as Partial<Config>;
  const sites: Site[] = [];
  for (const item of Array.isArray(raw.sites) ? raw.sites : []) {
    try {
      sites.push(normalizeSite(item));
    } catch {
      // A hand-edited invalid entry is skipped rather than breaking every other site.
    }
  }
  const defaultSite = sites.some((s) => s.id === raw.defaultSite) ? raw.defaultSite : sites[0]?.id;
  return { sites, defaultSite };
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
export function normalizeSite(input: unknown, existingKey = ''): Site {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id))
    throw new HttpError(400, '站点 ID 只能包含小写字母、数字和连字符');
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  const protocol = raw.protocol;
  if (protocol !== 'auto' && protocol !== 'openai' && protocol !== 'gemini')
    throw new HttpError(400, '协议类型无效');
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
export const publicSite = ({ apiKey, ...site }: Site) => ({
  ...site,
  hasKey: !!apiKey,
  keyHint: apiKey.length >= 12 ? `…${apiKey.slice(-4)}` : '',
});

// Headless setups configure one site through the MCP server's environment instead of the page.
export function applyEnvSite(env: NodeJS.ProcessEnv = process.env): void {
  const baseUrl = env.HROUTER_CANVAS_BASE_URL,
    apiKey = env.HROUTER_CANVAS_API_KEY;
  if (!baseUrl || !apiKey) return;
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
  const config = loadConfig();
  const current = config.sites.find((s) => s.id === 'env');
  if (current && JSON.stringify(current) === JSON.stringify(site) && config.defaultSite === 'env')
    return;
  saveConfig({ sites: [site, ...config.sites.filter((s) => s.id !== 'env')], defaultSite: 'env' });
}

export function resolveSite(config: Config, wanted?: string): Site {
  const usable = config.sites.filter((s) => s.apiKey);
  if (wanted) {
    const match = config.sites.find(
      (s) => s.id === wanted || s.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!match) throw new HttpError(400, `没有名为 ${wanted} 的生图站点`);
    if (!match.apiKey) throw new HttpError(409, `站点 ${match.name} 还没有填写 API Key`);
    return match;
  }
  const site = usable.find((s) => s.id === config.defaultSite) || usable[0];
  if (!site) throw new HttpError(409, '还没有配置可用的生图站点，请先在画布设置中填写站点地址和 API Key');
  return site;
}

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
