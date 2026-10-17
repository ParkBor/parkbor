import { describe, expect, it } from 'vitest';

import {
  formatDistance,
  formatDuration,
  formatPrice,
  formatPricePerHour,
  formatRating,
} from '@/features/map/format';

const NB = ' ';

describe('formatDistance', () => {
  it.each([
    [350, 'uz', '350 m'],
    [350, 'ru', '350 м'],
    [350, 'en', '350 m'],
    [999, 'en', '999 m'],
    [1000, 'en', '1 km'],
    [1200, 'en', '1.2 km'],
    [1200, 'uz', '1,2 km'],
    [1250, 'ru', '1,3 км'],
    [10000, 'ru', '10 км'],
    [0, 'uz', '0 m'],
  ] as const)('%d m in %s is %s', (meters, lang, expected) => {
    expect(formatDistance(meters, lang)).toBe(expected.replace(' ', NB));
  });

  it('rounds up into kilometers instead of showing 1000 m', () => {
    expect(formatDistance(999.6, 'en')).toBe(`1${NB}km`);
  });

  it('clamps invalid input to zero', () => {
    expect(formatDistance(-5, 'en')).toBe(`0${NB}m`);
    expect(formatDistance(Number.NaN, 'en')).toBe(`0${NB}m`);
  });
});

describe('formatDuration', () => {
  it.each([
    [120, 'uz', '2 dq'],
    [120, 'ru', '2 мин'],
    [120, 'en', '2 min'],
    [61, 'en', '2 min'],
    [1, 'en', '1 min'],
    [0, 'en', '1 min'],
    [3600, 'en', '1 h'],
    [3660, 'en', '1 h 1 min'],
    [3660, 'uz', '1 soat 1 dq'],
    [7500, 'ru', '2 ч 5 мин'],
  ] as const)('%d s in %s is %s', (seconds, lang, expected) => {
    // A number never separates from its unit (non-breaking space), like distance and price.
    expect(formatDuration(seconds, lang)).toBe(expected.replace(/(\d) /g, `$1${NB}`));
  });

  it('returns null when the backend has no duration', () => {
    expect(formatDuration(null, 'en')).toBeNull();
  });
});

describe('formatPrice', () => {
  it.each([
    ['12000.00', 'uz', `12${NB}000${NB}so‘m`],
    ['12000.00', 'ru', `12${NB}000${NB}сум`],
    ['12000.00', 'en', `12,000${NB}UZS`],
    ['500', 'uz', `500${NB}so‘m`],
    ['1234567.00', 'ru', `1${NB}234${NB}567${NB}сум`],
    ['0.00', 'en', `0${NB}UZS`],
  ] as const)('%s in %s', (price, lang, expected) => {
    expect(formatPrice(price, lang)).toBe(expected);
  });

  it('rounds the fractional part half up using exact decimal arithmetic', () => {
    expect(formatPrice('5000.49', 'en')).toBe(`5,000${NB}UZS`);
    expect(formatPrice('5000.50', 'en')).toBe(`5,001${NB}UZS`);
    expect(formatPrice('999.99', 'en')).toBe(`1,000${NB}UZS`);
  });

  it('returns null for a missing or malformed price', () => {
    expect(formatPrice(null, 'en')).toBeNull();
    expect(formatPrice('abc', 'en')).toBeNull();
    expect(formatPrice('-5.00', 'en')).toBeNull();
    expect(formatPrice('', 'en')).toBeNull();
  });
});

describe('formatPricePerHour', () => {
  it.each([
    ['uz', `12${NB}000${NB}so‘m/soat`],
    ['ru', `12${NB}000${NB}сум/ч`],
    ['en', `12,000${NB}UZS/h`],
  ] as const)('%s', (lang, expected) => {
    expect(formatPricePerHour('12000.00', lang)).toBe(expected);
  });

  it('returns null without a price', () => {
    expect(formatPricePerHour(null, 'uz')).toBeNull();
  });
});

describe('formatRating', () => {
  it('shows one decimal with the language separator', () => {
    expect(formatRating(4.6, 'en')).toBe('4.6');
    expect(formatRating(4.6, 'ru')).toBe('4,6');
    expect(formatRating(5, 'uz')).toBe('5,0');
    expect(formatRating(4.25, 'en')).toBe('4.3');
  });

  it('returns null when unrated or invalid', () => {
    expect(formatRating(null, 'en')).toBeNull();
    expect(formatRating(Number.NaN, 'en')).toBeNull();
  });
});
