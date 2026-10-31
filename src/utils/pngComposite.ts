/**
 * Lightweight, zero-dependency PNG decoder, alpha compositor, and encoder
 * built on Node's standard `node:zlib` module.
 *
 * Used when `include_image: true` is passed to `get_weather_imagery` so
 * transparent WMS / tile radar overlays can be composited over an Esri gray
 * canvas basemap (plus reference labels and a center location marker) and
 * returned as an MCP `image` content block for vision-capable AI clients.
 */

import { inflateSync, deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Precomputed CRC-32 lookup table for PNG chunk checksums */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

/**
 * Decode an 8-bit non-interlaced PNG buffer (RGBA, RGB, grayscale, or indexed palette)
 * into a flat `width * height * 4` RGBA Buffer.
 */
export function decodePngToRgba(buf: Buffer): DecodedPng {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) {
      break;
    }
    const data = buf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip 4-byte CRC
  }

  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    throw new Error(`Unsupported PNG dimensions: ${width}x${height}`);
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG bitDepth=${bitDepth} interlace=${interlace}`);
  }

  const bpp =
    colorType === 6
      ? 4
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : 1;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const expectedLength = height * (stride + 1);
  if (raw.length < expectedLength) {
    throw new Error(`Truncated PNG IDAT stream (${raw.length} < ${expectedLength})`);
  }

  const recon = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    const prevOut = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const byte = raw[rowIn + x];
      const a = x >= bpp ? recon[rowOut + x - bpp] : 0;
      const b = y > 0 ? recon[prevOut + x] : 0;
      const c = x >= bpp && y > 0 ? recon[prevOut + x - bpp] : 0;
      let val = byte;
      if (filter === 1) {
        val = (byte + a) & 0xff;
      } else if (filter === 2) {
        val = (byte + b) & 0xff;
      } else if (filter === 3) {
        val = (byte + ((a + b) >> 1)) & 0xff;
      } else if (filter === 4) {
        val = (byte + paethPredictor(a, b, c)) & 0xff;
      }
      recon[rowOut + x] = val;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  if (colorType === 6) {
    recon.copy(rgba);
  } else if (colorType === 2) {
    for (let i = 0, j = 0; i < recon.length; i += 3, j += 4) {
      rgba[j] = recon[i];
      rgba[j + 1] = recon[i + 1];
      rgba[j + 2] = recon[i + 2];
      rgba[j + 3] = 255;
    }
  } else if (colorType === 3 && palette) {
    for (let i = 0, j = 0; i < recon.length; i++, j += 4) {
      const idx = recon[i];
      rgba[j] = palette[idx * 3] ?? 0;
      rgba[j + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[j + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[j + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, j = 0; i < recon.length; i += 2, j += 4) {
      const gray = recon[i];
      rgba[j] = gray;
      rgba[j + 1] = gray;
      rgba[j + 2] = gray;
      rgba[j + 3] = recon[i + 1];
    }
  } else {
    for (let i = 0, j = 0; i < recon.length; i++, j += 4) {
      const gray = recon[i];
      rgba[j] = gray;
      rgba[j + 1] = gray;
      rgba[j + 2] = gray;
      rgba[j + 3] = 255;
    }
  }

  return { width, height, rgba };
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  chunk.writeUInt32BE(crc, 8 + data.length);
  return chunk;
}

/**
 * Encode a flat `width * height * 4` RGBA Buffer into a standard 8-bit RGBA PNG Buffer.
 */
export function encodeRgbaToPng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));

  // Filter 1 (Sub) gives good compression on map + radar graphics with low CPU overhead
  for (let y = 0; y < height; y++) {
    const rowIn = y * stride;
    const rowOut = y * (stride + 1);
    raw[rowOut] = 1; // Sub filter
    for (let x = 0; x < stride; x++) {
      const prev = x >= 4 ? rgba[rowIn + x - 4] : 0;
      raw[rowOut + 1 + x] = (rgba[rowIn + x] - prev) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth 8
  ihdr[9] = 6; // color type 6 (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace none

  const compressed = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Alpha-blend `overlay` RGBA buffer onto `target` RGBA buffer in-place.
 * If dimensions differ, nearest-neighbor sampling is used so a 256x256 tile can
 * still composite cleanly over a 512x512 basemap.
 */
export function alphaBlendRgba(
  target: Buffer,
  targetWidth: number,
  targetHeight: number,
  overlay: Buffer,
  overlayWidth: number,
  overlayHeight: number,
  opacity = 1
): void {
  const clampedOpacity = Math.max(0, Math.min(1, opacity));
  for (let y = 0; y < targetHeight; y++) {
    const oy =
      overlayHeight === targetHeight
        ? y
        : Math.min(overlayHeight - 1, Math.floor((y * overlayHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x++) {
      const ox =
        overlayWidth === targetWidth
          ? x
          : Math.min(overlayWidth - 1, Math.floor((x * overlayWidth) / targetWidth));

      const sIdx = (oy * overlayWidth + ox) * 4;
      const srcA = (overlay[sIdx + 3] / 255) * clampedOpacity;
      if (srcA <= 0) continue;

      const dIdx = (y * targetWidth + x) * 4;
      const dstA = target[dIdx + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) continue;

      target[dIdx] = Math.round(
        (overlay[sIdx] * srcA + target[dIdx] * dstA * (1 - srcA)) / outA
      );
      target[dIdx + 1] = Math.round(
        (overlay[sIdx + 1] * srcA + target[dIdx + 1] * dstA * (1 - srcA)) / outA
      );
      target[dIdx + 2] = Math.round(
        (overlay[sIdx + 2] * srcA + target[dIdx + 2] * dstA * (1 - srcA)) / outA
      );
      target[dIdx + 3] = Math.round(outA * 255);
    }
  }
}

/**
 * Draw a center location marker (red dot with white border) at `(width/2, height/2)`.
 */
export function drawCenterPin(rgba: Buffer, width: number, height: number): void {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const outerRadius = 7;
  const innerRadius = 4.5;

  for (let dy = -outerRadius - 1; dy <= outerRadius + 1; dy++) {
    const py = cy + dy;
    if (py < 0 || py >= height) continue;
    for (let dx = -outerRadius - 1; dx <= outerRadius + 1; dx++) {
      const px = cx + dx;
      if (px < 0 || px >= width) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > outerRadius) continue;

      const idx = (py * width + px) * 4;
      if (dist <= innerRadius) {
        // Red fill (#ef4444)
        rgba[idx] = 239;
        rgba[idx + 1] = 68;
        rgba[idx + 2] = 68;
        rgba[idx + 3] = 255;
      } else {
        // Crisp white halo (#ffffff)
        rgba[idx] = 255;
        rgba[idx + 1] = 255;
        rgba[idx + 2] = 255;
        rgba[idx + 3] = 255;
      }
    }
  }
}

/**
 * Composite a transparent radar PNG over an optional Esri basemap + reference label overlay,
 * draw a center location pin, and return the resulting PNG buffer.
 */
export function compositeRadarPng(options: {
  radarPng: Buffer;
  basePng?: Buffer | null;
  referencePng?: Buffer | null;
  radarOpacity?: number;
}): Buffer {
  const radarDecoded = decodePngToRgba(options.radarPng);

  let width = radarDecoded.width;
  let height = radarDecoded.height;
  let canvas: Buffer;

  if (options.basePng) {
    try {
      const baseDecoded = decodePngToRgba(options.basePng);
      width = baseDecoded.width;
      height = baseDecoded.height;
      canvas = Buffer.from(baseDecoded.rgba);
    } catch {
      canvas = createSolidGrayCanvas(width, height);
    }
  } else {
    canvas = createSolidGrayCanvas(width, height);
  }

  // Blend the radar layer over the basemap (default 0.82 opacity, matching the web console)
  alphaBlendRgba(
    canvas,
    width,
    height,
    radarDecoded.rgba,
    radarDecoded.width,
    radarDecoded.height,
    options.radarOpacity ?? 0.82
  );

  // Blend the city/state reference labels on top if available
  if (options.referencePng) {
    try {
      const refDecoded = decodePngToRgba(options.referencePng);
      alphaBlendRgba(
        canvas,
        width,
        height,
        refDecoded.rgba,
        refDecoded.width,
        refDecoded.height,
        1.0
      );
    } catch {
      // Ignore invalid reference label PNG
    }
  }

  // Draw the center location pin
  drawCenterPin(canvas, width, height);

  return encodeRgbaToPng(width, height, canvas);
}

function createSolidGrayCanvas(width: number, height: number): Buffer {
  const canvas = Buffer.alloc(width * height * 4);
  for (let i = 0; i < canvas.length; i += 4) {
    canvas[i] = 232; // #e8ecef light neutral gray
    canvas[i + 1] = 236;
    canvas[i + 2] = 239;
    canvas[i + 3] = 255;
  }
  return canvas;
}
