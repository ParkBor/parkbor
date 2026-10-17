import type { LatLng } from '@/features/map/geo';
import { isUsableFix } from '@/features/map/locationModel';

export interface Fix {
  lat: number;
  lng: number;
  /** Epoch milliseconds. */
  timestamp: number;
  accuracy: number | null;
}

export interface WatcherDeps {
  getLastKnown: () => Promise<Fix | null>;
  watch: (onFix: (fix: Fix) => void) => Promise<{ remove: () => void }>;
  now: () => number;
  /** null clears the position (permission lost). */
  onPosition: (position: LatLng | null) => void;
  /** Optional: the full fix (with accuracy), for consumers that must judge its quality. */
  onFix?: (fix: Fix | null) => void;
  /** Platform failure; deliberately carries no details (they may contain coordinates). */
  onError: () => void;
}

export interface LocationWatcher {
  start: () => Promise<void>;
  /** Stops following. By default also clears the position; `keepPosition` is for a mere pause. */
  stop: (options?: { keepPosition?: boolean }) => void;
}

/**
 * Follows the device position. A generation counter makes every `await` safe: if stop() (or a
 * newer start()) happened meanwhile, the late result is discarded and nothing stays subscribed.
 */
export function createLocationWatcher(deps: WatcherDeps): LocationWatcher {
  let generation = 0;
  let subscription: { remove: () => void } | null = null;
  let isStarting = false;

  const emit = (fix: Fix): void => {
    deps.onPosition({ lat: fix.lat, lng: fix.lng });
    deps.onFix?.(fix);
  };

  async function start(): Promise<void> {
    if (subscription || isStarting) return;
    isStarting = true;
    const mine = ++generation;
    try {
      const last = await deps.getLastKnown();
      if (mine !== generation) return;
      if (last && isUsableFix(last, deps.now())) emit(last);
      const watcher = await deps.watch((fix) => {
        if (mine === generation) emit(fix);
      });
      if (mine !== generation) {
        watcher.remove();
        return;
      }
      subscription = watcher;
    } catch {
      if (mine === generation) deps.onError();
    } finally {
      isStarting = false;
    }
  }

  function stop(options: { keepPosition?: boolean } = {}): void {
    generation += 1;
    subscription?.remove();
    subscription = null;
    isStarting = false;
    if (!options.keepPosition) {
      deps.onPosition(null);
      deps.onFix?.(null);
    }
  }

  return { start, stop };
}
