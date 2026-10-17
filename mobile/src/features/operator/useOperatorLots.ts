import { useQuery } from '@tanstack/react-query';

import { useIsAuthenticated } from '@/features/booking/useAuthenticated';
import { shouldRetry } from '@/features/map/mapError';
import { operatorApi } from '@/features/operator/operatorApi';
import { useOperatorStore } from '@/features/operator/operatorSession';
import { resolveActiveLot } from '@/features/operator/operatorStore';
import { LOTS_STALE_MS } from '@/features/operator/pollingPolicy';
import { shouldFetchOperatorLots } from '@/features/operator/tabVisibility';
import { useAuthStore } from '@/store/auth';

export const operatorKeys = {
  lots: ['operator', 'lots'] as const,
  slots: (lotId: string) => ['operator', 'slots', lotId] as const,
};

/** The lots this account may work in. Drivers never call the operator API. Memory cache only. */
export function useOperatorLots() {
  const role = useAuthStore((state) => state.user?.role);
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: operatorKeys.lots,
    queryFn: ({ signal }) => operatorApi.lots(signal),
    enabled: isAuthenticated && shouldFetchOperatorLots(role),
    staleTime: LOTS_STALE_MS,
    retry: shouldRetry,
  });
}

/** Lots plus the lot every request is made for (the chosen one, or the only one). */
export function useActiveLot() {
  const query = useOperatorLots();
  const selectedLotId = useOperatorStore((state) => state.selectedLotId);
  const lots = query.data ?? [];
  return { query, lots, lot: resolveActiveLot(lots, selectedLotId) };
}
