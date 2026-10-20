import { describe, expect, it } from 'vitest';

import {
  COMPACT_WIDTH,
  CONTENT_MAX_WIDTH,
  EXPANDED_WIDTH,
  LARGE_FONT_SCALE,
  SHORT_HEIGHT,
  layoutFor,
} from '@/theme/layout';

describe('layoutFor width classes', () => {
  it.each([
    [320, 'compact'],
    [COMPACT_WIDTH - 1, 'compact'],
    [COMPACT_WIDTH, 'regular'],
    [412, 'regular'],
    [EXPANDED_WIDTH - 1, 'regular'],
    [EXPANDED_WIDTH, 'expanded'],
    [1024, 'expanded'],
  ])('%i dp wide -> %s', (width, expected) => {
    expect(layoutFor(width, 800, 1).widthClass).toBe(expected);
  });
});

describe('content column', () => {
  it('uses the whole width on phones', () => {
    const layout = layoutFor(360, 740, 1);
    expect(layout.contentWidth).toBe(360);
    expect(layout.sideInset).toBe(0);
  });

  it('caps at 560 dp and centres on tablets and landscape', () => {
    const layout = layoutFor(1000, 700, 1);
    expect(layout.contentWidth).toBe(CONTENT_MAX_WIDTH);
    expect(layout.sideInset).toBe((1000 - CONTENT_MAX_WIDTH) / 2);
    expect(layout.isLandscape).toBe(true);
  });

  it('the column plus both side insets is exactly the window', () => {
    for (const width of [320, 360, 412, 600, 840, 1280]) {
      const layout = layoutFor(width, 800, 1);
      expect(layout.contentWidth + 2 * layout.sideInset).toBe(width);
    }
  });

  it('gutters shrink on small phones and the inner width excludes them', () => {
    expect(layoutFor(320, 640, 1).gutter).toBe(16);
    expect(layoutFor(320, 640, 1).innerWidth).toBe(288);
    expect(layoutFor(412, 900, 1).gutter).toBe(24);
    expect(layoutFor(412, 900, 1).innerWidth).toBe(364);
    expect(layoutFor(900, 900, 1).innerWidth).toBe(CONTENT_MAX_WIDTH - 48);
  });
});

describe('height and font scale', () => {
  it('flags short windows', () => {
    expect(layoutFor(360, SHORT_HEIGHT - 1, 1).isShort).toBe(true);
    expect(layoutFor(360, SHORT_HEIGHT, 1).isShort).toBe(false);
    expect(layoutFor(800, 360, 1).isShort).toBe(true);
  });

  it('flags portrait vs landscape', () => {
    expect(layoutFor(360, 740, 1).isLandscape).toBe(false);
    expect(layoutFor(740, 360, 1).isLandscape).toBe(true);
  });

  it('flags large system fonts from 1.3', () => {
    expect(layoutFor(360, 740, 1).isLargeFont).toBe(false);
    expect(layoutFor(360, 740, LARGE_FONT_SCALE - 0.01).isLargeFont).toBe(false);
    expect(layoutFor(360, 740, LARGE_FONT_SCALE).isLargeFont).toBe(true);
    expect(layoutFor(360, 740, 2).isLargeFont).toBe(true);
  });

  it('survives zero, NaN and negative window values (before the first measure)', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const layout = layoutFor(bad, bad, bad);
      expect(layout.contentWidth).toBeGreaterThan(0);
      expect(layout.innerWidth).toBeGreaterThan(0);
      expect(layout.isLargeFont).toBe(false);
    }
  });
});
