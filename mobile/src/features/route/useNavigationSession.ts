import { useEffect, useMemo, useRef, useState } from 'react';

import { haversineM, type LatLng } from '@/features/map/geo';
import type { Fix } from '@/features/map/locationWatcher';
import { useUserLocation, type UserLocation } from '@/features/map/UserLocation';
import type { NavigationLot } from '@/features/route/lotParams';
import { shouldShowRouteError } from '@/features/route/navigationView';
import { createRerouteGate } from '@/features/route/rerouting';
import type { RouteErrorKind } from '@/features/route/routeError';
import {
  createProgressTracker,
  fallbackGuidance,
  isTrustedFix,
  prepareRoute,
  type FallbackGuidance,
  type Progress,
} from '@/features/route/routeProgress';
import type { Route } from '@/features/route/routeSchemas';
import { roundRouteCoord } from '@/features/route/routesApi';
import { useRoute } from '@/features/route/useRoute';

export interface NavigationSession {
  location: UserLocation;
  /** Last successfully loaded route; stays visible while a new one loads or fails. */
  route: Route | null;
  /** Road progress; null without a trusted position or for an approximate route. */
  progress: Progress | null;
  /** Straight-line guidance; only for an approximate route with a trusted position. */
  guidance: FallbackGuidance | null;
  /** First load, nothing to show yet. */
  isLoading: boolean;
  /** A new route is being fetched while the old one is still shown. */
  isRerouting: boolean;
  /** Relevant error only (a stale reroute error disappears once back on the line). */
  error: RouteErrorKind | null;
  /** Arrived: GPS and keep-awake are released. */
  hasArrived: boolean;
  retry: () => void;
}

/** Moved more than this since the route request = "moving" (shorter re-ask interval). */
const MOVING_M = 30;

function sameRouteKey(a: LatLng, b: LatLng): boolean {
  return roundRouteCoord(a.lat) === roundRouteCoord(b.lat) && roundRouteCoord(a.lng) === roundRouteCoord(b.lng);
}

/**
 * Wires GPS (high accuracy, only while the screen is mounted, focused and not arrived), the route
 * query, progress tracking and the rerouting gate. The decisions live in routeProgress /
 * rerouting / navigationView (unit tested); this hook is wiring and is not covered by tests.
 * A failed re-request never removes the route on screen. Coordinates are never logged.
 */
export function useNavigationSession(lot: NavigationLot, initialOrigin: LatLng | null): NavigationSession {
  const [hasArrived, setHasArrived] = useState(false);
  const location = useUserLocation({ isNavigation: true, isPaused: hasArrived });
  const { position, fix } = location;
  const [origin, setOrigin] = useState<LatLng | null>(initialOrigin);
  const [shown, setShown] = useState<Route | null>(null);
  const [gate] = useState(() => createRerouteGate());

  // Derived-state updates during render (guarded, so they settle in one extra pass).
  if (origin === null && position !== null) setOrigin(position);
  const query = useRoute(origin, lot.location);
  if (query.route !== null && query.route !== shown) setShown(query.route);

  // Only accurate fixes drive next-step / arrival decisions; a poor fix is shown, nothing more.
  const [seenFix, setSeenFix] = useState<Fix | null>(null);
  const [trusted, setTrusted] = useState<LatLng | null>(null);
  if (fix !== seenFix) {
    setSeenFix(fix);
    if (fix && isTrustedFix(fix.accuracy)) setTrusted({ lat: fix.lat, lng: fix.lng });
  }

  const index = useMemo(() => (shown ? prepareRoute(shown) : null), [shown]);
  const tracker = useMemo(() => (index ? createProgressTracker(index) : null), [index]);
  const progress = useMemo(
    () => (tracker && trusted && shown && !shown.isApproximate ? tracker.update(trusted) : null),
    [tracker, trusted, shown],
  );
  const guidance = useMemo(
    () => (shown?.isApproximate && trusted ? fallbackGuidance(trusted, lot.location, shown) : null),
    [shown, trusted, lot.location],
  );

  if (!hasArrived && (progress?.isArrived || guidance?.isArrived)) setHasArrived(true);

  const latest = useRef({ origin, refetch: query.refetch, shown, progress });
  useEffect(() => {
    latest.current = { origin, refetch: query.refetch, shown, progress };
  });

  // Rerouting, judged on every fix.
  useEffect(() => {
    const { origin: currentOrigin, refetch, shown: route, progress: current } = latest.current;
    if (!fix || !route || hasArrived) return;
    const here = { lat: fix.lat, lng: fix.lng };
    const now = Date.now();
    const shouldAsk = route.isApproximate
      ? // No line to leave: re-ask now and then so a recovered routing service replaces the
        // straight line (>= 15 s when moving, >= 45 s standing still, soft backoff).
        gate.onApproximateFix({
          accuracyM: fix.accuracy,
          isMoving: currentOrigin !== null && haversineM(currentOrigin, here) > MOVING_M,
          nowMs: now,
        })
      : current !== null && gate.onFix({ distanceM: current.offRouteM, accuracyM: fix.accuracy, nowMs: now });
    if (!shouldAsk) return;
    gate.onRequestStarted(now);
    if (currentOrigin && sameRouteKey(currentOrigin, here)) refetch();
    else setOrigin(here);
  }, [fix, gate, hasArrived]);

  // Outcome of a request (network answer or cache hit) -> gate backoff.
  useEffect(() => {
    if (query.isFetching || !gate.isPending()) return;
    if (query.error !== null) gate.onResult(query.error === 'throttled' ? 'throttled' : 'error', Date.now());
    else gate.onResult(query.route?.isApproximate ? 'fallback' : 'ok', Date.now());
  }, [query.isFetching, query.error, query.route, gate]);

  const showError = shouldShowRouteError({
    hasRoute: shown !== null,
    offRouteM: progress?.offRouteM ?? null,
    hasError: query.error !== null,
  });

  return {
    location,
    route: shown,
    progress,
    guidance,
    isLoading: shown === null && query.isLoading,
    isRerouting: shown !== null && query.isFetching,
    error: showError ? query.error : null,
    hasArrived,
    retry: query.refetch,
  };
}
