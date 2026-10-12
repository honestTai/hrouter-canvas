export interface Site {
  id: string;
  name: string;
  baseUrl: string;
  protocol: 'auto' | 'openai' | 'gemini';
  models: string[];
  defaultModel?: string;
  hasKey: boolean;
  keyHint: string;
}
export interface CanvasImage {
  id: string;
  file: string;
  mime: string;
  width: number;
  height: number;
  x: number;
  y: number;
  displayWidth: number;
  kind: 'generated' | 'import';
  source: 'agent' | 'canvas';
  prompt: string;
  model: string;
  site: string;
  createdAt: number;
}
export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}
export interface Pending {
  id: string;
  prompt: string;
  model: string;
  startedAt: number;
}
export interface Board {
  id: string;
  title: string;
  viewport: { x: number; y: number; zoom: number };
  images: CanvasImage[];
  edges: CanvasEdge[];
  pending: Pending[];
}
export interface AppState {
  version: string;
  sites: Site[];
  defaultSite: string | null;
  current: string;
  boards: Array<{ id: string; title: string; updatedAt: number; count: number }>;
}
export class APIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; json?: unknown; body?: Blob } = {},
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: init.method || (init.json !== undefined || init.body ? 'POST' : 'GET'),
    headers: init.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new APIError(response.status, typeof value.error === 'string' ? value.error : '请求失败');
  return value as T;
}

// The agent opens the page with the local access token in the fragment (#t=...&settings). Trade
// it for an HttpOnly cookie and drop it from the address bar and history entry straight away.
export async function authorize(): Promise<{ settings: boolean }> {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('t');
  const settings = params.has('settings');
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (token) await api('auth', { json: { token } }).catch(() => {});
  return { settings };
}

export const imageUrl = (boardId: string, imageId: string, download = false) =>
  `/api/boards/${boardId}/images/${imageId}${download ? '?download=1' : ''}`;
