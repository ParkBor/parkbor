import * as Location from 'expo-location';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';

import type { LatLng } from '@/features/map/geo';
import {
  FIRST_FIX_WAIT_MS,
  deriveLocationState,
  isReadyToSearch,
  type LocationState,
} from '@/features/map/locationModel';
import { createLocationWatcher, type Fix } from '@/features/map/locationWatcher';

export type UserLocationState = LocationState | 'loading';

export interface UserLocation {
  /** Recent device position; null until a usable fix (or when not allowed). Never logged. */
  position: LatLng | null;
  /** Latest fix with accuracy/timestamp (navigation profile only; null otherwise). Never logged. */
  fix: Fix | null;
  state: UserLocationState;
  /** False while the permission prompt is open or the first fix is still awaited briefly. */
  isReady: boolean;
  /** Asks for the permission again (shows the system prompt when the OS still allows it). */
  requestAccess: () => Promise<void>;
  openSettings: () => void;
}

/** Map tab: coarse and cheap. */
const MAP_WATCH_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: 5000,
  distanceInterval: 50,
};

/** Navigation screen only (ARCH 11.2 step 5): every 5 m / 2 s, best accuracy. */
const NAVIGATION_WATCH_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  timeInterval: 2000,
  distanceInterval: 5,
};

export interface UserLocationOptions {
  /** High-accuracy profile for turn-by-turn navigation; the watch stops when the screen unmounts. */
  isNavigation?: boolean;
  /** Stop following (GPS off) while keeping the last position, e.g. after arriving. */
  isPaused?: boolean;
}

function toFix(location: Location.LocationObject): Fix {
  return {
    lat: location.coords.latitude,
    lng: location.coords.longitude,
    timestamp: location.timestamp,
    accuracy: location.coords.accuracy,
  };
}

/** Reads (or, with `prompt`, requests) the permission. Never throws, never logs. */
async function readAccess(prompt: boolean): Promise<LocationState> {
  try {
    const permission = prompt
      ? await Location.requestForegroundPermissionsAsync()
      : await Location.getForegroundPermissionsAsync();
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    return deriveLocationState(permission, servicesEnabled);
  } catch {
    return 'servicesOff';
  }
}

/**
 * Foreground location. Asks for the permission on first use and follows the position only while
 * the screen is focused. Without permission the map uses central Tashkent (see locationModel).
 * The decisions live in locationModel / locationWatcher (unit tested); this hook is wiring.
 */
export function useUserLocation({ isNavigation = false, isPaused = false }: UserLocationOptions = {}): UserLocation {
  const isFocused = useIsFocused();
  const [position, setPosition] = useState<LatLng | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [state, setState] = useState<UserLocationState>('loading');
  const [hasWaitedForFix, setHasWaitedForFix] = useState(false);
  const [watcher] = useState(() =>
    createLocationWatcher({
      getLastKnown: async () => {
        const last = await Location.getLastKnownPositionAsync();
        return last ? toFix(last) : null;
      },
      watch: (onFix) =>
        Location.watchPositionAsync(isNavigation ? NAVIGATION_WATCH_OPTIONS : MAP_WATCH_OPTIONS, (loc) =>
          onFix(toFix(loc)),
        ),
      now: () => Date.now(),
      onPosition: setPosition,
      onFix: isNavigation ? setFix : undefined,
      // Never log the underlying error: it can carry platform details.
      onError: () => setState('servicesOff'),
    }),
  );

  useEffect(() => {
    let isMounted = true;
    const apply = (next: LocationState): void => {
      if (isMounted) setState(next);
    };
    void readAccess(true).then(apply);
    // Back from the system settings: pick up a changed permission without prompting.
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') void readAccess(false).then(apply);
    });
    return () => {
      isMounted = false;
      appState.remove();
    };
  }, []);

  useEffect(() => {
    if (state === 'granted') {
      if (isFocused && !isPaused) void watcher.start();
    } else if (state !== 'loading') {
      watcher.stop();
    }
    // Leaving the tab (or unmounting) pauses GPS but keeps the last position for the search.
    return () => watcher.stop({ keepPosition: true });
  }, [state, isFocused, isPaused, watcher]);

  useEffect(() => {
    if (state !== 'granted' || position !== null || hasWaitedForFix) return;
    const timer = setTimeout(() => setHasWaitedForFix(true), FIRST_FIX_WAIT_MS);
    return () => clearTimeout(timer);
  }, [state, position, hasWaitedForFix]);

  const requestAccess = useCallback(async () => setState(await readAccess(true)), []);
  const openSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  const isReady = isReadyToSearch({ state, hasPosition: position !== null, hasWaitedForFix });
  return { position, fix, state, isReady, requestAccess, openSettings };
}
