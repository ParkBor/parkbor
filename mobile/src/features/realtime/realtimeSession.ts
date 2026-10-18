import type { QueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { AppState } from 'react-native';

import { isForegroundState } from '@/features/realtime/appState';
import { createCacheBridge, type CacheClient } from '@/features/realtime/cacheBridge';
import { createRealtimeClient, type SocketLike } from '@/features/realtime/realtimeClient';
import { fetchTicket } from '@/features/realtime/ticket';
import { api, authStore } from '@/lib/api';
import { getWsUrl } from '@/lib/config';
import { isOnline } from '@/lib/queryEnv';

/**
 * App-wide realtime connection (module singleton, like operatorSession). Not unit tested: it is
 * wiring of tested parts to React Native (WebSocket, AppState, expo-network, the auth store).
 */
export const realtimeClient = createRealtimeClient({
  wsUrl: getWsUrl(),
  // The JWT goes in the Authorization header of this request, never in the WebSocket URL.
  fetchTicket: () => fetchTicket(api),
  openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  refreshAccess: async () => {
    try {
      await authStore.getState().refreshAccess();
      return true;
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
  random: () => Math.random(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function sessionUserKey(): string | null {
  const { status, user } = authStore.getState();
  return status === 'authenticated' && user ? String(user.id) : null;
}

/** Connects the client to the session, app state, connectivity and the query cache. Returns the cleanup. */
export function startRealtime(queryClient: QueryClient): () => void {
  const bridge = createCacheBridge(queryClient as unknown as CacheClient);
  const unsubscribeEvents = realtimeClient.onEvent(bridge.handle);

  // Only `background` closes the socket: iOS `inactive` (notification shade, app switcher) does not.
  realtimeClient.setForeground(isForegroundState(AppState.currentState));
  const appStateSubscription = AppState.addEventListener('change', (state) =>
    realtimeClient.setForeground(isForegroundState(state)),
  );
  const networkSubscription = Network.addNetworkStateListener((state) => {
    if (isOnline(state)) realtimeClient.notifyOnline();
  });
  const unsubscribeSession = authStore.subscribe(() => realtimeClient.setSession(sessionUserKey()));
  realtimeClient.setSession(sessionUserKey());

  return () => {
    unsubscribeSession();
    networkSubscription.remove();
    appStateSubscription.remove();
    unsubscribeEvents();
    bridge.dispose();
    realtimeClient.setSession(null);
  };
}
