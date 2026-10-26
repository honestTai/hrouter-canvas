// When the canvas service has no ffmpeg, it asks an open page to read video frames: the
// browser's own player decodes them and the picture is posted back to the service.
export interface FrameRequest {
  id: string;
  url: string;
  kind: 'sheet' | 'frame';
  at?: 'first' | 'last' | number;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画面编码失败'))), type, quality),
  );

export async function captureFrames(request: FrameRequest): Promise<Blob> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('浏览器无法解码这个视频'));
      video.src = request.url;
    });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const seek = (time: number) =>
      new Promise<void>((resolve) => {
        if (Math.abs(video.currentTime - time) < 0.001) return resolve();
        video.onseeked = () => resolve();
        video.currentTime = time;
      });
    const end = Math.max(0, duration - 0.05);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    if (request.kind === 'frame') {
      const at = request.at ?? 'last';
      await seek(at === 'first' ? 0 : at === 'last' ? end : Math.min(at, end));
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0);
      return await toBlob(canvas, 'image/png');
    }
    // Same layout as the service's ffmpeg sheet: 0, ¼, ½ and ¾ of the clip, 2×2.
    const width = 480;
    const height = Math.round((width * video.videoHeight) / video.videoWidth / 2) * 2;
    canvas.width = width * 2;
    canvas.height = height * 2;
    for (const [i, part] of [0, 0.25, 0.5, 0.75].entries()) {
      await seek(duration * part);
      context.drawImage(video, (i % 2) * width, Math.floor(i / 2) * height, width, height);
    }
    return await toBlob(canvas, 'image/jpeg', 0.85);
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
