import { spawn, spawnSync } from 'node:child_process';

// What to pull out of a video: one full-size frame, or a 2×2 sheet of four evenly spaced frames
// that lets an agent see a video it cannot play.
export type FrameAt = 'first' | 'last' | number;
export type FrameRequest = { kind: 'frame'; at: FrameAt } | { kind: 'sheet' };

export function parseFrameAt(value: unknown): FrameAt | null {
  if (value === undefined || value === '' || value === 'last') return 'last';
  if (value === 'first') return 'first';
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600 ? seconds : null;
}
export const frameLabel = (at: FrameAt) =>
  at === 'first' ? '第一帧' : at === 'last' ? '最后一帧' : `${at} 秒处`;

// ffmpeg is optional. Without it, an open canvas page decodes frames with the browser's player.
let found: string | null | undefined;
export function ffmpegPath(): string | null {
  const wanted = process.env.HROUTER_CANVAS_FFMPEG;
  if (wanted === 'off') return null;
  if (wanted) return spawnSync(wanted, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0 ? wanted : null;
  found ??= spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0 ? 'ffmpeg' : null;
  return found;
}

export function ffmpegFrames(
  bin: string,
  file: string,
  duration: number | undefined,
  request: FrameRequest,
): Promise<Uint8Array> {
  const args = ['-v', 'error', '-nostdin'];
  if (request.kind === 'sheet') {
    // fps = 4 / duration yields frames at 0, ¼, ½ and ¾ of the clip.
    const fps = duration ? Math.max(0.01, 4 / duration) : 1;
    args.push('-i', file, '-vf', `fps=${fps.toFixed(4)},scale=480:-2,tile=2x2`, '-frames:v', '1');
    args.push('-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', '-');
  } else {
    // The last frame: seek near the end and take the final decoded frame by reversing that tail.
    if (request.at === 'last') args.push('-sseof', '-0.5');
    else args.push('-ss', String(request.at === 'first' ? 0 : request.at));
    args.push('-i', file, ...(request.at === 'last' ? ['-vf', 'reverse'] : []), '-frames:v', '1');
    args.push('-f', 'image2pipe', '-c:v', 'png', '-');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && size) resolve(new Uint8Array(Buffer.concat(chunks)));
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
}
