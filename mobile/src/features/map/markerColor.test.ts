import { describe, expect, it } from 'vitest';

import { markerColor, markerFill, markerLabel, readableTextColor } from '@/features/map/markerColor';
import { contrastRatio, darkPalette, lightPalette } from '@/theme/palette';

describe('markerColor', () => {
  it.each([
    // [free, total, expected] - green > 30%, yellow 10..30% inclusive, red < 10%
    [31, 100, 'green'],
    [4, 10, 'green'],
    [10, 10, 'green'],
    [30, 100, 'yellow'],
    [3, 10, 'yellow'],
    [10, 100, 'yellow'],
    [1, 10, 'yellow'],
    [9, 100, 'red'],
    [0, 10, 'red'],
    [1, 11, 'red'],
  ] as const)('free %i of %i is %s', (free, total, expected) => {
    expect(markerColor(free, total, true)).toBe(expected);
  });

  it('is gray for a closed lot regardless of free slots', () => {
    expect(markerColor(50, 50, false)).toBe('gray');
    expect(markerColor(0, 50, false)).toBe('gray');
  });

  it('treats a lot without capacity as red, never dividing by zero', () => {
    expect(markerColor(0, 0, true)).toBe('red');
  });

  it('treats corrupt counts defensively', () => {
    expect(markerColor(-5, 10, true)).toBe('red');
    expect(markerColor(Number.NaN, 10, true)).toBe('red');
    expect(markerColor(20, 10, true)).toBe('green');
  });
});

describe('markerLabel', () => {
  it('shows the free count for open lots', () => {
    expect(markerLabel(12, true)).toBe('12');
    expect(markerLabel(0, true)).toBe('0');
  });

  it('shows a dash instead of a misleading count for closed lots', () => {
    expect(markerLabel(12, false)).toBe('—');
  });
});

describe('marker palette', () => {
  it('maps kinds onto the theme colors', () => {
    expect(markerFill('green', lightPalette)).toBe(lightPalette.success);
    expect(markerFill('yellow', lightPalette)).toBe(lightPalette.warning);
    expect(markerFill('red', darkPalette)).toBe(darkPalette.error);
    expect(markerFill('gray', lightPalette)).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it.each(['light', 'dark'] as const)('keeps the label readable (>= 3:1) on every fill in %s mode', (mode) => {
    const palette = mode === 'light' ? lightPalette : darkPalette;
    for (const kind of ['green', 'yellow', 'red', 'gray'] as const) {
      const fill = markerFill(kind, palette);
      expect(contrastRatio(readableTextColor(fill), fill)).toBeGreaterThanOrEqual(3);
    }
  });

  it('picks the higher-contrast text color', () => {
    expect(readableTextColor('#000000')).toBe('#FFFFFF');
    expect(readableTextColor('#FFFFFF')).toBe('#111827');
  });
});
