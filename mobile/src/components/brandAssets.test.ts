/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
