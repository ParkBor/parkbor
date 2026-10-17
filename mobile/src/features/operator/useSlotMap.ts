import { onlineManager, useQuery } from '@tanstack/react-query';
import { useRef } from 'react';

import { useIsAuthenticated } from '@/features/booking/useAuthenticated';
import { shouldRetry } from '@/features/map/mapError';
import { operatorApi } from '@/features/operator/operatorApi';
import { slotPollInterval } from '@/features/operator/pollingPolicy';
import { useFocusState } from '@/features/operator/useFocusState';
import { operatorKeys } from '@/features/operator/useOperatorLots';

/**
 * One request per refresh (the server builds the whole map in a fixed number of queries). Polled
 * every 15 s only while the screen is focused, the app is in the foreground and online; failures
 * back off up to a minute. Realtime (WebSocket) arrives with Step 10.
 */
export function useSlotMap(lotId: string | null) {
  const isAuthenticated = useIsAuthenticated();
  const { isFocused, appState } = useFocusState();
  const failures = useRef(0);
  return useQuery({
    queryKey: operatorKeys.slots(lotId ?? 'none'),
    queryFn: async ({ signal }) => {
      try {
        const map = await operatorApi.slots(lotId ?? '', signal);
        failures.current = 0;
        return map;
      } catch (error: unknown) {
        failures.current += 1;
        throw error;
      }
    },
    enabled: lotId !== null && isAuthenticated,
    staleTime: 5000,
    retry: shouldRetry,
    refetchInterval: () =>
      slotPollInterval({
        isFocused,
        isAppActive: appState === 'active',
        isOnline: onlineManager.isOnline(),
        failures: failures.current,
      }),
  });
}
