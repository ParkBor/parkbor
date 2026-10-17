import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CENTER,
  MAX_FIX_ACCURACY_M,
  MAX_FIX_AGE_MS,
  deriveLocationState,
  isReadyToSearch,
  isUsableFix,
  resolveCenter,
} from '@/features/map/locationModel';

describe('isReadyToSearch', () => {
  it('waits while the permission prompt is pending (skeleton, not an empty result)', () => {
    expect(isReadyToSearch({ state: 'loading', hasPosition: false, hasWaitedForFix: false })).toBe(false);
  });

  it('waits for the first fix when allowed, until the wait budget is spent', () => {
    expect(isReadyToSearch({ state: 'granted', hasPosition: false, hasWaitedForFix: false })).toBe(false);
    expect(isReadyToSearch({ state: 'granted', hasPosition: true, hasWaitedForFix: false })).toBe(true);
    expect(isReadyToSearch({ state: 'granted', hasPosition: false, hasWaitedForFix: true })).toBe(true);
  });

  it.each(['denied', 'blocked', 'servicesOff'] as const)('searches around Tashkent right away when %s', (state) => {
    expect(isReadyToSearch({ state, hasPosition: false, hasWaitedForFix: false })).toBe(true);
  });
});

describe('isUsableFix', () => {
  const NOW = 1_000_000_000;
  it('accepts a recent, accurate fix', () => {
    expect(isUsableFix({ timestamp: NOW - 1000, accuracy: 30 }, NOW)).toBe(true);
  });

  it('rejects stale, inaccurate, unknown-accuracy and future fixes', () => {
    expect(isUsableFix({ timestamp: NOW - MAX_FIX_AGE_MS - 1, accuracy: 30 }, NOW)).toBe(false);
    expect(isUsableFix({ timestamp: NOW, accuracy: MAX_FIX_ACCURACY_M + 1 }, NOW)).toBe(false);
    expect(isUsableFix({ timestamp: NOW, accuracy: null }, NOW)).toBe(false);
    expect(isUsableFix({ timestamp: NOW + 60_000, accuracy: 30 }, NOW)).toBe(false);
  });
});

describe('DEFAULT_CENTER', () => {
  it('is the center of Tashkent', () => {
    expect(DEFAULT_CENTER).toEqual({ lat: 41.2995, lng: 69.2401 });
  });
});

describe('deriveLocationState', () => {
  it('is granted when permission and services are on', () => {
    expect(deriveLocationState({ status: 'granted', canAskAgain: true }, true)).toBe('granted');
  });

  it('reports services off even with permission', () => {
    expect(deriveLocationState({ status: 'granted', canAskAgain: true }, false)).toBe('servicesOff');
  });

  it('distinguishes a denial that can be retried from a blocked one', () => {
    expect(deriveLocationState({ status: 'denied', canAskAgain: true }, true)).toBe('denied');
    expect(deriveLocationState({ status: 'denied', canAskAgain: false }, true)).toBe('blocked');
  });

  it('treats undetermined as denied (not yet allowed)', () => {
    expect(deriveLocationState({ status: 'undetermined', canAskAgain: true }, true)).toBe('denied');
  });
});

describe('resolveCenter', () => {
  it('prefers the user position', () => {
    expect(resolveCenter({ lat: 41.1, lng: 69.1 })).toEqual({ lat: 41.1, lng: 69.1 });
  });

  it('falls back to Tashkent without a position', () => {
    expect(resolveCenter(null)).toEqual(DEFAULT_CENTER);
  });

  it('falls back when the position is out of range or not finite', () => {
    expect(resolveCenter({ lat: 200, lng: 69 })).toEqual(DEFAULT_CENTER);
    expect(resolveCenter({ lat: Number.NaN, lng: 69 })).toEqual(DEFAULT_CENTER);
  });
});
