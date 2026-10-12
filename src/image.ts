export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
}
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
// Output-only bounds: 4K PNGs can be much larger than reference uploads.
export const MAX_GENERATED_IMAGE_BYTES = 72 * 1024 * 1024;
export const MAX_GENERATION_RESPONSE_BYTES = 100 * 1024 * 1024;

// Header inspection: reject non-images and decompression bombs before anything is stored or shown.
export function inspectImage(bytes: Uint8Array): ImageInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mime: ImageInfo['mime'],
    width = 0,
    height = 0;
  const text = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
  if (bytes.length >= 24 && bytes[0] === 137 && text(1, 4) === 'PNG' && text(12, 16) === 'IHDR') {
    mime = 'image/png';
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') {
    mime = 'image/webp';
    const u24 = (i: number) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
    if (text(12, 16) === 'VP8X') {
      width = u24(24) + 1;
      height = u24(27) + 1;
    } else if (text(12, 16) === 'VP8L' && bytes[20] === 47) {
      width = 1 + (bytes[21] | ((bytes[22] & 63) << 8));
      height = 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 15) << 10));
    } else if (
      text(12, 16) === 'VP8 ' &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    ) {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    }
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg';
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i++] !== 255) break;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (i + 2 > bytes.length) break;
      const size = view.getUint16(i);
      if (size < 2 || i + size > bytes.length) break;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        size >= 7
      ) {
        height = view.getUint16(i + 3);
        width = view.getUint16(i + 5);
        break;
      }
      i += size;
    }
  } else {
    throw new Error('仅支持 PNG、JPEG、WebP 图片');
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000)
    throw new Error('图片尺寸无效或超过 4000 万像素');
  return { mime, width, height };
}
export const imageExtension = (mime: string) =>
  mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';

export type AspectRatio = `${number}:${number}`;
export function normalizeAspectRatio(value: unknown): AspectRatio | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(value)) return null;
  const [width, height] = value.split(':').map(Number);
  if (width > 1000 || height > 1000) return null;
  let a = width,
    b = height;
  while (b) [a, b] = [b, a % b];
  return `${width / a}:${height / a}`;
}
