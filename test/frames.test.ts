// Runs the real ffmpeg path on a clip ffmpeg makes itself. Skipped when ffmpeg is not installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downscaleImage, ffmpegFrames, ffmpegPath, parseFrameAt } from '../src/frames.ts';
import { imageHasAlpha, inspectImage, inspectVideo } from '../src/image.ts';
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
    const largePng = join(dir, '4k.png');
    assert.equal(
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=1:duration=1', '-frames:v', '1', largePng]).status,
      0,
    );
    const preview = await downscaleImage(largePng, join(dir, 'preview.jpg'));
    assert.ok(preview && preview.byteLength < 400 * 1024);
    assert.deepEqual(inspectImage(preview), { mime: 'image/jpeg', width: 1280, height: 720 });
    assert.equal(imageHasAlpha(new Uint8Array(readFileSync(largePng)), 'image/png'), false);

    // Reference upload slimming: 2048px JPEG for opaque images, PNG preserved when RGBA has alpha.
    const slimJpg = await downscaleImage(largePng, join(dir, 'ref.jpg'), { maxEdge: 2048, format: 'jpeg', quality: 88 });
    assert.ok(slimJpg && slimJpg.byteLength < 800 * 1024);
    assert.deepEqual(inspectImage(slimJpg), { mime: 'image/jpeg', width: 2048, height: 1152 });

    const alphaPng = join(dir, 'alpha.png');
    assert.equal(
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.5:s=2400x1200:d=1,format=rgba', '-frames:v', '1', alphaPng]).status,
      0,
    );
    assert.equal(imageHasAlpha(new Uint8Array(readFileSync(alphaPng)), 'image/png'), true);
    const slimPng = await downscaleImage(alphaPng, join(dir, 'ref.png'), { maxEdge: 2048, format: 'png' });
    assert.ok(slimPng);
    assert.deepEqual(inspectImage(slimPng), { mime: 'image/png', width: 2048, height: 1024 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
