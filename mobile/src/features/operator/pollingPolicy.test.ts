import { describe, expect, it } from 'vitest';

import {
  MAX_POLL_MS,
  roleRefreshDue,
  ROLE_REFRESH_MS,
  SLOT_POLL_MS,
  slotPollInterval,
} from '@/features/operator/pollingPolicy';

const on = { isFocused: true, isAppActive: true, isOnline: true, failures: 0 };

describe('slotPollInterval', () => {
  it('polls every 15 s while the screen is focused, the app active and online', () => {
    expect(SLOT_POLL_MS).toBe(15_000);
    expect(slotPollInterval(on)).toBe(15_000);
  });

  it.each([
    { isFocused: false },
    { isAppActive: false },
    { isOnline: false },
  ])('stops for %j', (patch) => {
    expect(slotPollInterval({ ...on, ...patch })).toBe(false);
  });

  it('backs off exponentially after failures, capped at one minute', () => {
    expect(slotPollInterval({ ...on, failures: 1 })).toBe(30_000);
    expect(slotPollInterval({ ...on, failures: 2 })).toBe(60_000);
    expect(slotPollInterval({ ...on, failures: 9 })).toBe(MAX_POLL_MS);
  });

  it('treats a negative failure count as none', () => {
    expect(slotPollInterval({ ...on, failures: -3 })).toBe(15_000);
  });
});

describe('roleRefreshDue', () => {
  it('is due at once when never refreshed, then once per interval', () => {
    expect(roleRefreshDue({ lastAtMs: null, nowMs: 1000 })).toBe(true);
    expect(roleRefreshDue({ lastAtMs: 1000, nowMs: 1000 + ROLE_REFRESH_MS - 1 })).toBe(false);
    expect(roleRefreshDue({ lastAtMs: 1000, nowMs: 1000 + ROLE_REFRESH_MS })).toBe(true);
  });

  it('a clock that moved backwards counts as due', () => {
    expect(roleRefreshDue({ lastAtMs: 10_000, nowMs: 5_000 })).toBe(true);
  });

});
