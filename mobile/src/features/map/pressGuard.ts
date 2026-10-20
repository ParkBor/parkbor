export const PRESS_SUPPRESS_MS = 350;

export interface PressGuard {
  /** A marker (or cluster) was tapped: the map-level tap that may follow it must be ignored. */
  markTapped: () => void;
  /** False for a map tap that is really the echo of a marker tap. */
  shouldHandleMapPress: () => boolean;
}

/**
 * Marker views and the map both report a tap; on some devices the map's tap arrives after the marker's and would
 * undo the selection. A marker tap suppresses map taps for a moment.
 */
export function createPressGuard(now: () => number, windowMs: number = PRESS_SUPPRESS_MS): PressGuard {
  let lastMarkerTap = Number.NEGATIVE_INFINITY;
  return {
    markTapped() {
      lastMarkerTap = now();
    },
    shouldHandleMapPress() {
      const elapsed = now() - lastMarkerTap;
      return elapsed < 0 || elapsed >= windowMs;
    },
  };
}
