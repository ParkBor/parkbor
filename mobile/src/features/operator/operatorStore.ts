import { createStore, type StoreApi } from 'zustand/vanilla';

import type { OperatorLot } from '@/features/operator/operatorSchemas';

/** What was not shown: a check-in / check-out answer ('gate') or a walk-in registration. */
export type LostKind = 'gate' | 'walk_in';

export type ScanMode = 'entry' | 'exit';

/**
 * Operator working state. Memory only - never written to disk (a lot id is not personal data, but
 * there is no reason to outlive the app session either). Cleared when the session ends.
 */
export interface OperatorState {
  selectedLotId: string | null;
  /** Per-lot "check the plate on entry" switch (default off; see lotPolicy.effectivePlateCheck). */
  verifyPlate: Readonly<Record<string, boolean>>;
  mode: ScanMode;
  /** A request finished after its screen was left: show "result not shown" when a scanner is back. */
  lostResult: LostKind | null;
  /** A cash step is on screen: the screen must not be rebuilt (see scanPolicy.shouldWipe). */
  cashPending: boolean;
  selectLot: (lotId: string | null) => void;
  setVerifyPlate: (lotId: string, enabled: boolean) => void;
  setMode: (mode: ScanMode) => void;
  markLostResult: (kind?: LostKind) => void;
  setCashPending: (isPending: boolean) => void;
  /** Returns whether a lost result was waiting, and clears the flag. */
  takeLostResult: (kind?: LostKind) => boolean;
  reset: () => void;
}

const INITIAL = { selectedLotId: null, verifyPlate: {}, mode: 'entry', lostResult: null, cashPending: false } as const;

export function createOperatorStore(): StoreApi<OperatorState> {
  return createStore<OperatorState>()((set, get) => ({
    ...INITIAL,
    selectLot: (selectedLotId) => set({ selectedLotId }),
    setVerifyPlate: (lotId, enabled) => set((state) => ({ verifyPlate: { ...state.verifyPlate, [lotId]: enabled } })),
    setMode: (mode) => set({ mode }),
    markLostResult: (kind = 'gate') => set({ lostResult: kind }),
    setCashPending: (cashPending) => set({ cashPending }),
    takeLostResult: (kind = 'gate') => {
      const wasLost = get().lostResult === kind;
      if (wasLost) set({ lostResult: null });
      return wasLost;
    },
    reset: () => set({ ...INITIAL, verifyPlate: {} }),
  }));
}

/**
 * The lot every request is made for: the chosen one if it is still in the list, else the only lot,
 * else null (the operator must choose). Scan requests always carry its id (no 400 parking_lot_required).
 */
export function resolveActiveLot(lots: readonly OperatorLot[], selectedId: string | null): OperatorLot | null {
  if (selectedId !== null) {
    const chosen = lots.find((lot) => lot.id === selectedId);
    if (chosen) return chosen;
  }
  return lots.length === 1 ? (lots[0] ?? null) : null;
}
