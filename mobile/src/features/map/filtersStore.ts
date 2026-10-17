import { useStore } from 'zustand';

import { createFiltersStore, type FiltersState } from '@/features/map/filters';

/** In-memory only: filters reset on app restart (nothing about the search is persisted). */
export const filtersStore = createFiltersStore();

export function useFiltersStore<T>(selector: (state: FiltersState) => T): T {
  return useStore(filtersStore, selector);
}
