import { describe, expect, it } from 'vitest';

import { createStaleFilter } from '@/features/realtime/staleFilter';

const LOT = '2f9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';
const OTHER = '3f9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';

describe('stale availability filter (ts compared as strings)', () => {
  it('accepts the first event for a lot (the snapshot)', () => {
    expect(createStaleFilter().accept(LOT, '2026-10-15T13:05:00.123Z')).toBe(true);
  });

  it('drops an event older than what was already applied', () => {
    const filter = createStaleFilter();
    filter.accept(LOT, '2026-10-15T13:05:00.500Z');
    expect(filter.accept(LOT, '2026-10-15T13:05:00.499Z')).toBe(false);
    expect(filter.accept(LOT, '2026-10-15T13:04:59.999Z')).toBe(false);
  });

  it('accepts newer and equal timestamps', () => {
    const filter = createStaleFilter();
    filter.accept(LOT, '2026-10-15T13:05:00.500Z');
    expect(filter.accept(LOT, '2026-10-15T13:05:00.500Z')).toBe(true);
    expect(filter.accept(LOT, '2026-10-15T13:05:00.501Z')).toBe(true);
  });

  it('keeps lots independent', () => {
    const filter = createStaleFilter();
    filter.accept(LOT, '2026-10-15T13:05:00.500Z');
    expect(filter.accept(OTHER, '2026-10-15T13:00:00.000Z')).toBe(true);
  });

  it('a dropped event does not move the baseline back', () => {
    const filter = createStaleFilter();
    filter.accept(LOT, '2026-10-15T13:05:00.500Z');
    filter.accept(LOT, '2026-10-15T13:00:00.000Z');
    expect(filter.accept(LOT, '2026-10-15T13:04:00.000Z')).toBe(false);
  });

  it('forget() and clear() reset the baseline', () => {
    const filter = createStaleFilter();
    filter.accept(LOT, '2026-10-15T13:05:00.500Z');
    filter.forget(LOT);
    expect(filter.accept(LOT, '2026-10-15T13:00:00.000Z')).toBe(true);
    filter.clear();
    expect(filter.accept(LOT, '2026-10-15T12:00:00.000Z')).toBe(true);
  });

  it('stays bounded: the oldest lots are forgotten first', () => {
    const filter = createStaleFilter(2);
    filter.accept('a', '2026-10-15T13:05:00.500Z');
    filter.accept('b', '2026-10-15T13:05:00.500Z');
    filter.accept('c', '2026-10-15T13:05:00.500Z');
    expect(filter.size()).toBe(2);
    expect(filter.accept('a', '2026-10-15T12:00:00.000Z')).toBe(true);
  });
});
