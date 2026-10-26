// Runs the real ffmpeg path on a clip ffmpeg makes itself. Skipped when ffmpeg is not installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ffmpegFrames, ffmpegPath, parseFrameAt } from '../src/frames.ts';
import { inspectImage, inspectVideo } from '../src/image.ts';
import { readFileSync } from 'node:fs';

test('frame positions are parsed strictly', () => {
  assert.equal(parseFrameAt(undefined), 'last');
  assert.equal(parseFrameAt('first'), 'first');
  assert.equal(parseFrameAt(2.5), 2.5);
  assert.equal(parseFrameAt('1.5'), 1.5);
  assert.equal(parseFrameAt('middle'), null);
  assert.equal(parseFrameAt(-1), null);
});

test('ffmpeg reads a keyframe sheet and single frames', { skip: !ffmpegPath() && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hrouter-canvas-frames-'));
  try {
    const clip = join(dir, 'clip.mp4');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=2', '-pix_fmt', 'yuv420p', clip]);
    assert.equal(made.status, 0);
    const info = inspectVideo(new Uint8Array(readFileSync(clip)));
    assert.deepEqual([info.width, info.height, info.duration], [320, 180, 2]);
    const sheet = inspectImage(await ffmpegFrames('ffmpeg', clip, info.duration, { kind: 'sheet' }));
    assert.deepEqual(sheet, { mime: 'image/jpeg', width: 960, height: 540 });
    for (const at of ['first', 'last', 1] as const)
      assert.deepEqual(inspectImage(await ffmpegFrames('ffmpeg', clip, info.duration, { kind: 'frame', at })), {
        mime: 'image/png',
        width: 320,
        height: 180,
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
