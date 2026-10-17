import { haversineM, type LatLng } from '@/features/map/geo';

/** Leaving the line by more than this triggers a new route (ARCH 10.2). */
export const OFF_ROUTE_M = 50;
/** A fix less accurate than this proves nothing about being off the route. */
export const MAX_ACCURACY_M = 50;
/** Consecutive trustworthy off-route fixes required (a single GPS jump must not reroute). */
export const REQUIRED_FIXES = 2;
export const MIN_INTERVAL_MS = 15_000;
const THROTTLE_BASE_MS = 60_000;
const ERROR_BASE_MS = MIN_INTERVAL_MS * 2;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Approximate (fallback) route: ask again to catch a recovered routing service. */
export const STATIONARY_RETRY_MS = 45_000;
const MAX_FALLBACK_WAIT_MS = 60_000;
const MAX_APPROXIMATE_ACCURACY_M = 100;

/** 'fallback': the server answered, but with a straight line (not a real recovery). */
export type RerouteOutcome = 'ok' | 'fallback' | 'throttled' | 'error';

export interface FixSample {
  /** Distance from the route line (routeProgress.distanceToPolylineM). */
  distanceM: number;
  accuracyM: number | null;
  nowMs: number;
}

export interface ApproximateSample {
  accuracyM: number | null;
  /** Has the user moved noticeably since the last request? */
  isMoving: boolean;
  nowMs: number;
}

export interface RerouteGate {
  /** Feed every position fix; true means "request a new route now". */
  onFix: (sample: FixSample) => boolean;
  /**
   * While the shown route is an approximate straight line there is no line to leave; instead the
   * server is asked again every >= 15 s when moving, >= 45 s when standing still, with a soft
   * backoff (15, 30, 60 s) for consecutive fallback answers.
   */
  onApproximateFix: (sample: ApproximateSample) => boolean;
  onRequestStarted: (nowMs: number) => void;
  onResult: (outcome: RerouteOutcome, nowMs: number) => void;
  /** Earliest time (epoch ms) the next request may start. */
  nextAllowedAt: () => number;
  /** A request was started and its outcome has not been reported yet. */
  isPending: () => boolean;
  reset: () => void;
}

/**
 * Decides when to ask /routes again: only after REQUIRED_FIXES consecutive accurate fixes beyond
 * OFF_ROUTE_M, never while a request runs, at least MIN_INTERVAL_MS apart, and with exponential
 * backoff after failures (a 429 backs off from a full minute: the server throttle is per minute).
 */
export function createRerouteGate(): RerouteGate {
  let streak = 0;
  let isInFlight = false;
  let nextAllowed = 0;
  let failures = 0;
  let fallbackStreak = 0;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  const backoff = (baseMs: number): number => Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, failures - 1));

  return {
    onFix({ distanceM, accuracyM, nowMs }) {
      if (accuracyM === null || !Number.isFinite(accuracyM) || accuracyM > MAX_ACCURACY_M) return false;
      if (!(distanceM > OFF_ROUTE_M)) {
        streak = 0;
        return false;
      }
      streak += 1;
      return streak >= REQUIRED_FIXES && !isInFlight && nowMs >= nextAllowed;
    },
    onApproximateFix({ accuracyM, isMoving, nowMs }) {
      if (accuracyM === null || !Number.isFinite(accuracyM) || accuracyM > MAX_APPROXIMATE_ACCURACY_M) return false;
      if (isInFlight || nowMs < nextAllowed) return false;
      return nowMs - lastStartedAt >= (isMoving ? MIN_INTERVAL_MS : STATIONARY_RETRY_MS);
    },
    onRequestStarted(nowMs) {
      lastStartedAt = nowMs;
      isInFlight = true;
      streak = 0;
      nextAllowed = Math.max(nextAllowed, nowMs + MIN_INTERVAL_MS);
    },
    onResult(outcome, nowMs) {
      isInFlight = false;
      if (outcome === 'ok') {
        failures = 0;
        fallbackStreak = 0;
        return;
      }
      if (outcome === 'fallback') {
        // Soft: counted from the request start; real error backoff (failures) is left alone.
        fallbackStreak += 1;
        const wait = Math.min(MAX_FALLBACK_WAIT_MS, MIN_INTERVAL_MS * 2 ** (fallbackStreak - 1));
        nextAllowed = Math.max(nextAllowed, lastStartedAt + wait);
        return;
      }
      failures += 1;
      const wait = backoff(outcome === 'throttled' ? THROTTLE_BASE_MS : ERROR_BASE_MS);
      nextAllowed = Math.max(nextAllowed, nowMs + wait);
    },
    nextAllowedAt: () => nextAllowed,
    isPending: () => isInFlight,
    reset() {
      streak = 0;
      isInFlight = false;
      nextAllowed = 0;
      failures = 0;
      fallbackStreak = 0;
      lastStartedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

export interface AlternativeCandidate {
  id: string;
  name: string;
  freeSlots: number;
  isOpen: boolean;
  location: LatLng;
}

export interface AlternativeSuggestion<T extends AlternativeCandidate = AlternativeCandidate> {
  lot: T;
  distanceM: number;
}

/**
 * Next best lot when the selected one runs out of spots (ARCH 11.2 step 6): nearest open lot
 * with free spots other than the selected one.
 * Nothing calls this yet. TODO(websocket): call it when the live-availability message says the
 * selected lot is full and offer the result as a banner. Until then the navigation screen only
 * has the "Another parking lot" button, which returns to the map / nearby list.
 */
export function pickAlternative<T extends AlternativeCandidate>(
  candidates: readonly T[],
  selectedId: string,
  from: LatLng,
): AlternativeSuggestion<T> | null {
  let best: AlternativeSuggestion<T> | null = null;
  for (const lot of candidates) {
    if (lot.id === selectedId || !lot.isOpen || lot.freeSlots <= 0) continue;
    const distanceM = haversineM(from, lot.location);
    if (best === null || distanceM < best.distanceM) best = { lot, distanceM };
  }
  return best;
}
