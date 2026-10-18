import { useEffect, useSyncExternalStore } from 'react';

import { realtimeClient } from '@/features/realtime/realtimeSession';

export interface GroupRequest {
  kind: 'lot' | 'geo' | 'operator_lot';
  id: string;
}

/**
 * Wants these groups while the component is mounted and `isEnabled`. Releasing happens on unmount,
 * on a change of the list and when disabled. The server also drops groups with the connection and
 * the client resubscribes after every reconnect, so nothing else is needed here.
 */
export function useRealtimeGroups(groups: readonly GroupRequest[], isEnabled: boolean = true): void {
  const signature = groups.map((group) => `${group.kind}:${group.id}`).join('|');
  useEffect(() => {
    if (!isEnabled || signature === '') return;
    const requests = signature.split('|').map((entry): GroupRequest => {
      const [kind, id] = entry.split(':') as [GroupRequest['kind'], string];
      return { kind, id };
    });
    return realtimeClient.subscribe(requests);
  }, [signature, isEnabled]);
}

/** True while events flow; screens use it to relax their polling (pollFallback.relaxWhenLive). */
export function useRealtimeLive(): boolean {
  return useSyncExternalStore(realtimeClient.onStatus, () => realtimeClient.getStatus() === 'live');
}
