import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureHome, HttpError } from './config.ts';
import { imageExtension, inspectImage, type ImageInfo } from './image.ts';

export interface Point {
  x: number;
  y: number;
}
export interface CanvasImage extends ImageInfo, Point {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
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
export interface Board {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  viewport: { x: number; y: number; zoom: number };
  images: CanvasImage[];
  edges: CanvasEdge[];
}
export const MAX_IMAGES = 500;
const DISPLAY_WIDTH = 320;
const newId = () => randomBytes(8).toString('hex');
const validId = (id: string) => /^[a-f0-9]{16}$/.test(id);

// Disk is the source of truth: the browser is a view, and agents get real file paths.
export class Store {
  private boards = new Map<string, Board>();
  private root: string;
  constructor() {
    this.root = join(ensureHome(), 'boards');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  private dir(id: string) {
    if (!validId(id)) throw new HttpError(400, '画布 ID 无效');
    return join(this.root, id);
  }
  private save(board: Board) {
    board.updatedAt = Date.now();
    const path = join(this.dir(board.id), 'board.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(board));
    renameSync(`${path}.tmp`, path);
  }
  list(): Array<Pick<Board, 'id' | 'title' | 'updatedAt'> & { count: number }> {
    return readdirSync(this.root)
      .filter(validId)
      .flatMap((id) => {
        try {
          const b = this.get(id);
          return [{ id, title: b.title, updatedAt: b.updatedAt, count: b.images.length }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): Board {
    const cached = this.boards.get(id);
    if (cached) return cached;
    let board: Board;
    try {
      board = JSON.parse(readFileSync(join(this.dir(id), 'board.json'), 'utf8'));
    } catch {
      throw new HttpError(404, '画布不存在');
    }
    this.boards.set(id, board);
    return board;
  }
  create(title = '新的画布'): Board {
    const now = Date.now();
    const board: Board = {
      id: newId(),
      title: title.trim().slice(0, 60) || '新的画布',
      createdAt: now,
      updatedAt: now,
      viewport: { x: 0, y: 0, zoom: 1 },
      images: [],
      edges: [],
    };
    mkdirSync(join(this.dir(board.id), 'images'), { recursive: true, mode: 0o700 });
    this.boards.set(board.id, board);
    this.save(board);
    this.select(board.id);
    return board;
  }
  current(): Board {
    try {
      return this.get(readFileSync(join(this.root, 'current'), 'utf8').trim());
    } catch {
      const latest = this.list()[0];
      return latest ? this.get(latest.id) : this.create();
    }
  }
  select(id: string): Board {
    const board = this.get(id);
    writeFileSync(join(this.root, 'current'), id);
    return board;
  }
  remove(id: string) {
    this.get(id);
    rmSync(this.dir(id), { recursive: true, force: true });
    this.boards.delete(id);
  }
  imagePath(board: Board, image: CanvasImage) {
    return join(this.dir(board.id), 'images', image.file);
  }
  read(board: Board, id: string): { image: CanvasImage; bytes: Uint8Array } {
    const image = board.images.find((i) => i.id === id);
    if (!image) throw new HttpError(404, '图片不存在');
    return { image, bytes: new Uint8Array(readFileSync(this.imagePath(board, image))) };
  }

  private place(board: Board, info: ImageInfo, parents: CanvasImage[], at?: Point): Point {
    const height = (DISPLAY_WIDTH * info.height) / info.width;
    const boxes = board.images.map((i) => ({
      x: i.x,
      y: i.y,
      w: i.displayWidth,
      h: (i.displayWidth * i.height) / i.width,
    }));
    const free = (p: Point) =>
      !boxes.some(
        (b) =>
          p.x < b.x + b.w + 20 &&
          p.x + DISPLAY_WIDTH + 20 > b.x &&
          p.y < b.y + b.h + 20 &&
          p.y + height + 20 > b.y,
      );
    let point: Point;
    if (at) point = { ...at };
    else if (parents.length)
      // Results sit to the right of what they were made from, so edges read left to right.
      point = { x: Math.max(...parents.map((p) => p.x + p.displayWidth)) + 110, y: parents[0].y };
    else if (!boxes.length) point = { x: 0, y: 0 };
    else {
      const last = board.images[board.images.length - 1];
      const left = Math.min(...boxes.map((b) => b.x));
      point = { x: last.x + last.displayWidth + 40, y: last.y };
      if (point.x - left > 4 * (DISPLAY_WIDTH + 40) - 1)
        point = { x: left, y: Math.max(...boxes.map((b) => b.y + b.h)) + 40 };
    }
    for (let i = 0; i < 200 && !free(point); i++) point = { x: point.x, y: point.y + 60 };
    return { x: Math.round(point.x), y: Math.round(point.y) };
  }

  add(
    board: Board,
    bytes: Uint8Array,
    meta: Pick<CanvasImage, 'kind' | 'source' | 'prompt' | 'model' | 'site'>,
    options: { parents?: string[]; at?: Point } = {},
  ): CanvasImage {
    const info = inspectImage(bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Re-importing the same reference file reuses its node instead of piling up copies.
    if (meta.kind === 'import') {
      const same = board.images.find((i) => i.kind === 'import' && i.sha256 === sha256);
      if (same) return same;
    }
    if (board.images.length >= MAX_IMAGES)
      throw new HttpError(409, `单个画布最多 ${MAX_IMAGES} 张图片，请新建画布`);
    const parents = (options.parents || []).flatMap(
      (id) => board.images.find((i) => i.id === id) || [],
    );
    const id = newId();
    const image: CanvasImage = {
      id,
      file: `${id}.${imageExtension(info.mime)}`,
      bytes: bytes.byteLength,
      sha256,
      ...info,
      ...this.place(board, info, parents, options.at),
      displayWidth: DISPLAY_WIDTH,
      ...meta,
      prompt: meta.prompt.slice(0, 8000),
      createdAt: Date.now(),
    };
    const dir = join(this.dir(board.id), 'images');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, image.file), bytes);
    board.images.push(image);
    for (const parent of parents)
      board.edges.push({ id: newId(), source: parent.id, target: image.id });
    this.save(board);
    return image;
  }
  removeImage(board: Board, id: string) {
    const image = board.images.find((i) => i.id === id);
    if (!image) return;
    board.images = board.images.filter((i) => i.id !== id);
    board.edges = board.edges.filter((e) => e.source !== id && e.target !== id);
    rmSync(this.imagePath(board, image), { force: true });
    this.save(board);
  }
  // Layout edits from the page: every field is validated, unknown ids are ignored.
  patch(board: Board, input: unknown) {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (typeof raw.title === 'string' && raw.title.trim())
      board.title = raw.title.trim().slice(0, 60);
    const v = raw.viewport as Board['viewport'] | undefined;
    if (v && finite(v.x) && finite(v.y) && finite(v.zoom) && v.zoom > 0)
      board.viewport = { x: v.x, y: v.y, zoom: v.zoom };
    if (Array.isArray(raw.positions))
      for (const p of raw.positions as Array<Point & { id: string }>) {
        const image = board.images.find((i) => i.id === p?.id);
        if (image && finite(p.x) && finite(p.y)) Object.assign(image, { x: p.x, y: p.y });
      }
    if (Array.isArray(raw.edges)) {
      const ids = new Set(board.images.map((i) => i.id));
      const seen = new Set<string>();
      board.edges = (raw.edges as CanvasEdge[])
        .filter((e) => {
          const key = `${e?.source}>${e?.target}`;
          if (!ids.has(e?.source) || !ids.has(e?.target) || e.source === e.target || seen.has(key))
            return false;
          seen.add(key);
          return true;
        })
        .slice(0, 2000)
        .map((e) => ({
          id: typeof e.id === 'string' && validId(e.id) ? e.id : newId(),
          source: e.source,
          target: e.target,
        }));
    }
    this.save(board);
  }
}
