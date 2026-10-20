/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { FULL_LOGO_SIZE, MARK_LOGO_SIZE, aspectRatio } from '@/components/brandAssets';

const IMAGES = join(__dirname, '..', '..', 'assets', 'images');

/** width, height and colour type from the PNG IHDR chunk. */
function pngInfo(name: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(join(IMAGES, name));
  expect(bytes.subarray(0, 8).toString('hex'), `${name} is a PNG`).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] ?? -1 };
}

const RGB = 2;
const RGBA = 6;

describe('brand assets', () => {
  it('the store icon is 1024x1024 and opaque (no alpha channel: iOS rejects transparency)', () => {
    expect(pngInfo('icon.png')).toEqual({ width: 1024, height: 1024, colorType: RGB });
  });

  it('the adaptive icon layers are 1024 square; the foreground and monochrome layers have alpha', () => {
    expect(pngInfo('android-icon-foreground.png')).toEqual({ width: 1024, height: 1024, colorType: RGBA });
    expect(pngInfo('android-icon-monochrome.png')).toEqual({ width: 1024, height: 1024, colorType: RGBA });
    expect(pngInfo('android-icon-background.png')).toMatchObject({ width: 1024, height: 1024 });
  });

  it('the favicon is 48x48 with alpha', () => {
    expect(pngInfo('favicon.png')).toEqual({ width: 48, height: 48, colorType: RGBA });
  });

  it('the splash logo is wide and transparent', () => {
    const splash = pngInfo('splash-icon.png');
    expect(splash.colorType).toBe(RGBA);
    expect(splash.width).toBeGreaterThan(splash.height * 2);
  });

  it('BrandLogo sizes match the PNG files', () => {
    const full = pngInfo('parkbor-logo.png');
    const mark = pngInfo('parkbor-mark.png');
    expect(full).toMatchObject({ ...FULL_LOGO_SIZE, colorType: RGBA });
    expect(mark).toMatchObject({ ...MARK_LOGO_SIZE, colorType: RGBA });
    expect(aspectRatio(FULL_LOGO_SIZE)).toBeCloseTo(full.width / full.height, 5);
  });
});

// --- pixel checks: launchers mask icons, so what matters is how far the art reaches from the centre ---

interface Pixels {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

/** Minimal decoder for the 8-bit, non-interlaced RGB/RGBA PNGs the asset script writes. */
function decodePng(name: string): Pixels {
  const bytes = readFileSync(join(IMAGES, name));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(bytes[24], `${name}: 8-bit`).toBe(8);
  expect(bytes[28], `${name}: not interlaced`).toBe(0);
  const channels = bytes[25] === RGBA ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('latin1', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (data[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (data[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (data[(y - 1) * stride + x - channels] ?? 0) : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      data[y * stride + x] = (value + predictor) & 255;
    }
  }
  return { width, height, channels, data };
}

/** Largest distance (in px of a 1024 canvas) from the canvas centre to a pixel that `isInk` says is art. */
function farthestInk(image: Pixels, isInk: (r: number, g: number, b: number, a: number) => boolean): number {
  const cx = (image.width - 1) / 2;
  const cy = (image.height - 1) / 2;
  let farthest = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * image.channels;
      const a = image.channels === 4 ? (image.data[i + 3] ?? 255) : 255;
      if (isInk(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0, a)) {
        farthest = Math.max(farthest, Math.hypot(x - cx, y - cy));
      }
    }
  }
  return (farthest * 1024) / image.width;
}

/** Android circle masks guarantee 66/108 of the canvas as a diameter: 313 px at 1024. */
const ADAPTIVE_SAFE_RADIUS = 313;
const ADAPTIVE_BUDGET = 290;
/** iOS masks with a rounded square, whose corners cut at about 450 px from the centre; keep clear of that. */
const IOS_BUDGET = 400;

describe('icon art stays inside what launchers show', () => {
  const opaque = (_r: number, _g: number, _b: number, a: number) => a > 8;

  it.each(['android-icon-foreground.png', 'android-icon-monochrome.png', 'splash-icon-android.png'])(
    '%s: no opaque pixel farther than %i px from the centre (circle-mask safe zone is 313)',
    (name) => {
      const radius = farthestInk(decodePng(name), opaque);
      expect(radius).toBeLessThanOrEqual(ADAPTIVE_BUDGET);
      expect(radius).toBeLessThan(ADAPTIVE_SAFE_RADIUS);
      // and it is not shrunk to nothing
      expect(radius).toBeGreaterThan(ADAPTIVE_BUDGET * 0.9);
    },
  );

  it('the adaptive foreground art is centred', () => {
    const image = decodePng('android-icon-foreground.png');
    let minX = image.width;
    let maxX = 0;
    let minY = image.height;
    let maxY = 0;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) > 8) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    expect(Math.abs((minX + maxX) / 2 - (image.width - 1) / 2)).toBeLessThan(3);
    expect(Math.abs((minY + maxY) / 2 - (image.height - 1) / 2)).toBeLessThan(3);
  });

  it('the iOS icon art (anything not white) stays well inside the rounded-square mask', () => {
    const nonWhite = (r: number, g: number, b: number) => Math.min(r, g, b) < 235;
    expect(farthestInk(decodePng('icon.png'), nonWhite)).toBeLessThanOrEqual(IOS_BUDGET);
  });
});
