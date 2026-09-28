// What a stored image file is, read from its bytes alone: type (by
// signature), sha256, pixel size and JPEG EXIF orientation. No decoder, no
// transformation — the bytes are only read. Used by source-assets (0055); the
// size and signature rules mirror brand-scan's so both agree on a file.

export type ImageMeta = {
  content_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: number;
  raw_width: number;
  raw_height: number;
  orientation: number; // EXIF 1–8; 1 when absent or not a JPEG
  width: number;       // as displayed (EXIF 5–8 swap width and height)
  height: number;
};

export function sniffImageType(b: Uint8Array): ImageMeta["content_type"] | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export function imageSize(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (type === "image/png" && bytes.length > 24) {
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    if (type === "image/gif" && bytes.length > 10) {
      return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    }
    if (type === "image/webp" && bytes.length > 30) {
      const chunk = String.fromCharCode(...bytes.slice(12, 16));
      if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L") {
        const b = bytes.slice(21, 25);
        return { width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) };
      }
      if (chunk === "VP8X") {
        return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
      }
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const marker = bytes[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = dv.getUint16(i + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

// EXIF orientation from a JPEG's APP1 segment (1 when there is none).
export function jpegOrientation(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    let i = 2;
    while (i + 4 < bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1];
      const len = dv.getUint16(i + 2);
      if (marker === 0xda) break; // start of scan: no more headers
      if (marker === 0xe1 && String.fromCharCode(...bytes.slice(i + 4, i + 8)) === "Exif") {
        const t = i + 10; // TIFF header
        const little = bytes[t] === 0x49;
        const u16 = (o: number) => dv.getUint16(o, little);
        const u32 = (o: number) => dv.getUint32(o, little);
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) {
            const v = u16(e + 8);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
        return 1;
      }
      i += 2 + len;
    }
  } catch {
    // fall through
  }
  return 1;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// null: not an image this module can measure (unknown signature, SVG,
// truncated header). The caller reports it; it never guesses.
export function measure(bytes: Uint8Array): ImageMeta | null {
  const type = sniffImageType(bytes);
  if (!type) return null;
  const size = imageSize(bytes, type);
  if (!size || size.width <= 0 || size.height <= 0) return null;
  const orientation = type === "image/jpeg" ? jpegOrientation(bytes) : 1;
  const swap = orientation >= 5 && orientation <= 8;
  return {
    content_type: type,
    bytes: bytes.byteLength,
    raw_width: size.width,
    raw_height: size.height,
    orientation,
    width: swap ? size.height : size.width,
    height: swap ? size.width : size.height,
  };
}
