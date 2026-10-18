import { onlineManager, useQuery } from '@tanstack/react-query';
import { useRef } from 'react';

import { useIsAuthenticated } from '@/features/booking/useAuthenticated';
import { shouldRetry } from '@/features/map/mapError';
import { operatorApi } from '@/features/operator/operatorApi';
import { slotPollInterval } from '@/features/operator/pollingPolicy';
import { useFocusState } from '@/features/operator/useFocusState';
import { operatorKeys } from '@/features/operator/useOperatorLots';
import { relaxWhenLive } from '@/features/realtime/pollFallback';
import { useRealtimeGroups, useRealtimeLive } from '@/features/realtime/useRealtime';

/**
 * One request per refresh (the server builds the whole map in a fixed number of queries). Polled
 * every 15 s only while the screen is focused, the app is in the foreground and online; failures
 * back off up to a minute. Realtime (WebSocket, Step 10b) patches the map; polling slows to a safety net while it is live.
 */
export function useSlotMap(lotId: string | null) {
  const isAuthenticated = useIsAuthenticated();
  const { isFocused, appState } = useFocusState();
  const failures = useRef(0);
  // slot_status for this lot; the 15 s polling remains the fallback while the socket is down.
  const isLive = useRealtimeLive();
  useRealtimeGroups(
    lotId === null ? [] : [{ kind: 'operator_lot', id: lotId }],
    isAuthenticated && isFocused && appState !== 'background',
  );
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
      relaxWhenLive(
        slotPollInterval({
          isFocused,
          isAppActive: appState === 'active',
          isOnline: onlineManager.isOnline(),
          failures: failures.current,
        }),
        isLive,
      ),
  });
}
