import { useStore } from 'zustand';

import { createOperatorStore, type OperatorState } from '@/features/operator/operatorStore';

/** App-wide operator working state (memory only; reset with the session in app/_layout). */
export const operatorStore = createOperatorStore();

export function useOperatorStore<T>(selector: (state: OperatorState) => T): T {
  return useStore(operatorStore, selector);
}
