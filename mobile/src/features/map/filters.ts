import { createStore, type StoreApi } from 'zustand/vanilla';

import { SLOT_TYPES, SORT_MODES, type SlotType, type SortMode } from '@/features/map/schemas';

/** Backend accepts 100..10000 m; these are the choices offered in the filters sheet. */
export const RADIUS_OPTIONS_M = [500, 1000, 3000, 5000, 10_000] as const;

export interface MapFilters {
  radiusM: number;
  slotType: SlotType | null;
  sort: SortMode;
  onlyOpen: boolean;
}

export const DEFAULT_FILTERS: MapFilters = {
  radiusM: 3000,
  slotType: null,
  sort: 'recommended',
  onlyOpen: false,
};

export interface FiltersState {
  filters: MapFilters;
  setRadius: (radiusM: number) => void;
  setSlotType: (slotType: SlotType | null) => void;
  setSort: (sort: SortMode) => void;
  setOnlyOpen: (onlyOpen: boolean) => void;
  reset: () => void;
}

function nearestRadius(value: number): number {
  return RADIUS_OPTIONS_M.reduce<number>(
    (best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best),
    RADIUS_OPTIONS_M[0],
  );
}

/** Number of narrowing filters changed from default (sort is not a filter). */
export function activeFilterCount(filters: MapFilters): number {
  return (
    Number(filters.radiusM !== DEFAULT_FILTERS.radiusM) +
    Number(filters.slotType !== null) +
    Number(filters.onlyOpen)
  );
}

export function createFiltersStore(): StoreApi<FiltersState> {
  return createStore<FiltersState>()((set) => ({
    filters: DEFAULT_FILTERS,
    setRadius: (radiusM) => {
      if (!Number.isFinite(radiusM)) return;
      set((s) => ({ filters: { ...s.filters, radiusM: nearestRadius(radiusM) } }));
    },
    setSlotType: (slotType) => {
      if (slotType !== null && !SLOT_TYPES.includes(slotType)) return;
      set((s) => ({ filters: { ...s.filters, slotType } }));
    },
    setSort: (sort) => {
      if (!SORT_MODES.includes(sort)) return;
      set((s) => ({ filters: { ...s.filters, sort } }));
    },
    setOnlyOpen: (onlyOpen) => set((s) => ({ filters: { ...s.filters, onlyOpen } })),
    reset: () => set({ filters: DEFAULT_FILTERS }),
  }));
}
