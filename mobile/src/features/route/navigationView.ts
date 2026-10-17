import type { UserLocationState } from '@/features/map/UserLocation';
import { OFF_ROUTE_M } from '@/features/route/rerouting';
import { maneuverProximity, type Progress } from '@/features/route/routeProgress';
import type { Route } from '@/features/route/routeSchemas';

export type NavigationViewKind =
  /** Waiting for the first route. */
  | 'loading'
  /** First route failed and there is nothing to show. */
  | 'error'
  /** Location allowed but no fix yet. */
  | 'waitingFix'
  /** No route and no way to build one (location off): only the external navigator remains. */
  | 'locationOff'
  /** A route is shown, but without the user's position: route view only. */
  | 'routeOnly'
  /** Straight-line fallback: direction and distance only, never turn-by-turn. */
  | 'approximate'
  /** Left the line (or a new route is being fetched): the old maneuver is no longer valid. */
  | 'offRoute'
  | 'turn'
  | 'arrived';

export interface NavigationViewInput {
  route: Route | null;
  progress: Progress | null;
  locationState: UserLocationState;
  isLoading: boolean;
  hasError: boolean;
  isRerouting: boolean;
}

function isWaitingForLocation(state: UserLocationState): boolean {
  return state === 'granted' || state === 'loading';
}

/** Which main card the navigation screen shows. Pure, so every state is unit tested. */
export function deriveNavigationView(input: NavigationViewInput): NavigationViewKind {
  const { route, progress, locationState, isLoading, hasError, isRerouting } = input;
  if (route === null) {
    if (hasError) return 'error';
    if (isLoading) return 'loading';
    return isWaitingForLocation(locationState) ? 'waitingFix' : 'locationOff';
  }
  if (route.isApproximate) return 'approximate';
  if (progress === null) return isWaitingForLocation(locationState) ? 'waitingFix' : 'routeOnly';
  if (progress.isArrived) return 'arrived';
  return progress.offRouteM > OFF_ROUTE_M || isRerouting ? 'offRoute' : 'turn';
}

export interface RouteErrorVisibility {
  hasRoute: boolean;
  /** Distance from the line of the latest trusted fix; null when unknown. */
  offRouteM: number | null;
  hasError: boolean;
}

/**
 * A failed request is shown while it is relevant: always when there is no route, and with a
 * route only while the user is still off the line. Back on the line the old route is valid again,
 * so "could not update the route" disappears.
 */
export function shouldShowRouteError({ hasRoute, offRouteM, hasError }: RouteErrorVisibility): boolean {
  if (!hasError) return false;
  if (!hasRoute) return true;
  return offRouteM === null || offRouteM > OFF_ROUTE_M;
}

export interface RemainingSummary {
  distanceM: number;
  durationS: number;
}

/**
 * The single "remaining" figure: live numbers whenever they exist (progress along the road, or
 * the straight-line guidance), static route totals only as the last resort. This keeps the card
 * and the bottom bar from showing two different distances.
 */
export function remainingSummary(
  kind: NavigationViewKind,
  route: Route | null,
  progress: Progress | null,
  guidance: { distanceM: number; remainingS: number } | null,
): RemainingSummary | null {
  if (kind === 'approximate' && guidance) return { distanceM: guidance.distanceM, durationS: guidance.remainingS };
  if (progress && kind !== 'approximate') return { distanceM: progress.remainingM, durationS: progress.remainingS };
  return route ? { distanceM: route.distanceM, durationS: route.durationS } : null;
}

/**
 * Key for screen-reader announcements: changes only when the next step or its proximity class
 * (far / soon / now) changes - not on every few meters.
 */
export function announcementKey(kind: NavigationViewKind, progress: Progress | null): string | null {
  if (kind === 'arrived') return 'arrived';
  if (kind === 'offRoute') return 'offRoute';
  if (kind !== 'turn' || !progress?.nextStep) return null;
  return `${progress.nextStep.index}:${maneuverProximity(progress.nextStep.distanceM)}`;
}

/**
 * Re-fit the camera for the first route and for every real (osrm) route - a reroute or the
 * switch from a straight line to a real road - but not for each straight-line refresh, which
 * would keep yanking the map while the user looks at it.
 */
export function shouldFitRoute(previous: Route | null, next: Route): boolean {
  return previous === null || !next.isApproximate;
}
