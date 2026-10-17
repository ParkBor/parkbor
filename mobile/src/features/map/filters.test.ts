import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FILTERS,
  RADIUS_OPTIONS_M,
  activeFilterCount,
  createFiltersStore,
} from '@/features/map/filters';

describe('filters store', () => {
  it('starts from the documented defaults', () => {
    expect(createFiltersStore().getState().filters).toEqual({
      radiusM: 3000,
      slotType: null,
      sort: 'recommended',
      onlyOpen: false,
    });
  });

  it('updates each filter independently without mutating previous state', () => {
    const store = createFiltersStore();
    const before = store.getState().filters;
    store.getState().setSlotType('EV');
    store.getState().setSort('cheapest');
    store.getState().setOnlyOpen(true);
    store.getState().setRadius(5000);
    expect(store.getState().filters).toEqual({ radiusM: 5000, slotType: 'EV', sort: 'cheapest', onlyOpen: true });
    expect(before).toEqual(DEFAULT_FILTERS);
  });

  it('snaps the radius to the nearest allowed option', () => {
    const store = createFiltersStore();
    store.getState().setRadius(4200);
    expect(RADIUS_OPTIONS_M).toContain(store.getState().filters.radiusM);
    expect(store.getState().filters.radiusM).toBe(5000);
    store.getState().setRadius(1);
    expect(store.getState().filters.radiusM).toBe(RADIUS_OPTIONS_M[0]);
    store.getState().setRadius(10 ** 9);
    expect(store.getState().filters.radiusM).toBe(10_000);
  });

  it('ignores invalid values', () => {
    const store = createFiltersStore();
    store.getState().setRadius(Number.NaN);
    store.getState().setSort('bogus' as never);
    store.getState().setSlotType('BOGUS' as never);
    expect(store.getState().filters).toEqual(DEFAULT_FILTERS);
  });

  it('clears the slot type with null and resets everything', () => {
    const store = createFiltersStore();
    store.getState().setSlotType('LARGE');
    store.getState().setSlotType(null);
    expect(store.getState().filters.slotType).toBeNull();
    store.getState().setOnlyOpen(true);
    store.getState().reset();
    expect(store.getState().filters).toEqual(DEFAULT_FILTERS);
  });
});

describe('activeFilterCount', () => {
  it('counts only deviations from the defaults (sort excluded)', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, sort: 'nearest' })).toBe(0);
    expect(activeFilterCount({ radiusM: 1000, slotType: 'EV', sort: 'recommended', onlyOpen: true })).toBe(3);
  });
});
