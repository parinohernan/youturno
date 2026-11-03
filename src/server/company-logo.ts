export const MAX_LOGO_BYTES = 512 * 1024;
export const MAX_LOGO_DIMENSION = 4096;

export class BodyTooLarge extends Error {}

/** Enforce the limit while streaming, including chunked bodies without Content-Length. */
export async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit) throw new BodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new BodyTooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Inspect signatures and dimensions without decoding untrusted full-resolution pixels. */
export function validLogo(bytes: Uint8Array, mime: string): boolean {
  if (!bytes.length || bytes.length > MAX_LOGO_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = (w: number, h: number) => w > 0 && h > 0 && w <= MAX_LOGO_DIMENSION && h <= MAX_LOGO_DIMENSION;
  if (mime === "image/png") {
    if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return false;
    let offset = 8;
    let imageData = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset);
      if (size > bytes.length - offset - 12) return false;
      const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (offset === 8 && (kind !== "IHDR" || size !== 13 || !dimensions(view.getUint32(16), view.getUint32(20)))) return false;
      if (kind === "IDAT" && size > 0) imageData = true;
      if (kind === "IEND") return size === 0 && imageData && offset + 12 === bytes.length;
      offset += size + 12;
    }
    return false;
  }
  if (mime !== "image/jpeg" || bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 ||
    bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return false;
  let offset = 2;
  let frame = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    const size = offset + 2 <= bytes.length ? view.getUint16(offset) : 0;
    if (size < 2 || offset + size > bytes.length) return false;
    if ([192, 193, 194].includes(marker)) {
      if (size < 8 || !dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3))) return false;
      frame = true;
    }
    if (marker === 218) return frame && offset + size < bytes.length - 2;
    offset += size;
  }
  return false;
}
