import { describe, expect, it } from 'vitest';

import { eastRoute, step } from '@/features/route/fixtures';
import {
  announcementKey,
  deriveNavigationView,
  remainingSummary,
  shouldFitRoute,
  shouldShowRouteError,
  type NavigationViewInput,
} from '@/features/route/navigationView';
import type { Progress } from '@/features/route/routeProgress';

const progress = (over: Partial<Progress> = {}): Progress => ({
  offRouteM: 0,
  alongM: 0,
  segment: 0,
  remainingM: 1000,
  remainingS: 100,
  nextStep: null,
  isArrived: false,
  ...over,
});

const base: NavigationViewInput = {
  route: null,
  progress: null,
  locationState: 'granted',
  isLoading: false,
  hasError: false,
  isRerouting: false,
};

describe('deriveNavigationView', () => {
  it('no route: error beats loading, loading beats waiting', () => {
    expect(deriveNavigationView({ ...base, hasError: true, isLoading: true })).toBe('error');
    expect(deriveNavigationView({ ...base, isLoading: true })).toBe('loading');
  });

  it('no route and no request: waits for a fix when location is allowed, otherwise location-off', () => {
    expect(deriveNavigationView(base)).toBe('waitingFix');
    expect(deriveNavigationView({ ...base, locationState: 'loading' })).toBe('waitingFix');
    for (const state of ['denied', 'blocked', 'servicesOff'] as const) {
      expect(deriveNavigationView({ ...base, locationState: state })).toBe('locationOff');
    }
  });

  it('a fallback route is always the approximate view, never turn-by-turn', () => {
    const route = eastRoute({ source: 'fallback', isApproximate: true });
    expect(deriveNavigationView({ ...base, route, progress: progress() })).toBe('approximate');
    expect(deriveNavigationView({ ...base, route, locationState: 'denied' })).toBe('approximate');
  });

  it('an osrm route marked approximate by the server is also approximate', () => {
    const route = eastRoute({ source: 'osrm', isApproximate: true });
    expect(deriveNavigationView({ ...base, route, progress: progress() })).toBe('approximate');
  });

  it('a real route without a position is route-only when location is off, waiting otherwise', () => {
    const route = eastRoute();
    expect(deriveNavigationView({ ...base, route, locationState: 'denied' })).toBe('routeOnly');
    expect(deriveNavigationView({ ...base, route })).toBe('waitingFix');
  });

  it('a real route with progress is turn-by-turn, then arrived', () => {
    const route = eastRoute();
    expect(deriveNavigationView({ ...base, route, progress: progress() })).toBe('turn');
    expect(deriveNavigationView({ ...base, route, progress: progress({ isArrived: true }) })).toBe('arrived');
  });

  it('keeps showing the old route when a new request failed', () => {
    const route = eastRoute();
    expect(deriveNavigationView({ ...base, route, progress: progress(), hasError: true })).toBe('turn');
  });

  it('beyond 50 m from the line or while rerouting it must not show the old maneuver', () => {
    const route = eastRoute();
    expect(deriveNavigationView({ ...base, route, progress: progress({ offRouteM: 51 }) })).toBe('offRoute');
    expect(deriveNavigationView({ ...base, route, progress: progress({ offRouteM: 50 }) })).toBe('turn');
    expect(deriveNavigationView({ ...base, route, progress: progress(), isRerouting: true })).toBe('offRoute');
  });

  it('arrival wins over off-route', () => {
    const route = eastRoute();
    expect(
      deriveNavigationView({ ...base, route, progress: progress({ offRouteM: 90, isArrived: true }) }),
    ).toBe('arrived');
  });
});

describe('shouldShowRouteError', () => {
  it('shows an error without a route and hides a stale reroute error once back on the line', () => {
    expect(shouldShowRouteError({ hasRoute: false, offRouteM: null, hasError: true })).toBe(true);
    expect(shouldShowRouteError({ hasRoute: true, offRouteM: 120, hasError: true })).toBe(true);
    expect(shouldShowRouteError({ hasRoute: true, offRouteM: 12, hasError: true })).toBe(false);
    expect(shouldShowRouteError({ hasRoute: true, offRouteM: null, hasError: true })).toBe(true);
    expect(shouldShowRouteError({ hasRoute: true, offRouteM: 200, hasError: false })).toBe(false);
  });
});

describe('remainingSummary (one source of truth)', () => {
  const route = eastRoute({ distanceM: 5000, durationS: 600 });
  const guidance = { distanceM: 800, remainingS: 90 };

  it('uses progress for turn-by-turn and arrival', () => {
    const p = progress({ remainingM: 1234, remainingS: 77 });
    expect(remainingSummary('turn', route, p, null)).toEqual({ distanceM: 1234, durationS: 77 });
    expect(remainingSummary('offRoute', route, p, null)).toEqual({ distanceM: 1234, durationS: 77 });
  });

  it('uses the live straight-line numbers in the approximate view, never the static route totals', () => {
    expect(remainingSummary('approximate', route, null, guidance)).toEqual({ distanceM: 800, durationS: 90 });
  });

  it('falls back to the route totals only when nothing live exists', () => {
    expect(remainingSummary('routeOnly', route, null, null)).toEqual({ distanceM: 5000, durationS: 600 });
    expect(remainingSummary('approximate', route, null, null)).toEqual({ distanceM: 5000, durationS: 600 });
    expect(remainingSummary('loading', null, null, null)).toBeNull();
  });
});

describe('announcementKey', () => {
  const next = (distanceM: number, index = 1) => ({ step: step({ key: 'turn_left' }), index, distanceM });

  it('changes only when the step or the proximity class changes, not every few meters', () => {
    const far1 = announcementKey('turn', progress({ nextStep: next(900) }));
    const far2 = announcementKey('turn', progress({ nextStep: next(880) }));
    expect(far1).toBe(far2);
    expect(announcementKey('turn', progress({ nextStep: next(100) }))).not.toBe(far1);
    expect(announcementKey('turn', progress({ nextStep: next(20) }))).not.toBe(
      announcementKey('turn', progress({ nextStep: next(100) })),
    );
    expect(announcementKey('turn', progress({ nextStep: next(900, 2) }))).not.toBe(far1);
  });

  it('announces arrival and leaving the route once, and nothing for other views', () => {
    expect(announcementKey('arrived', progress())).toBe('arrived');
    expect(announcementKey('offRoute', progress())).toBe('offRoute');
    expect(announcementKey('loading', null)).toBeNull();
    expect(announcementKey('turn', progress({ nextStep: null }))).toBeNull();
  });
});

describe('shouldFitRoute', () => {
  const real = eastRoute();
  const straight = eastRoute({ source: 'fallback', isApproximate: true });

  it('fits the first route, even a straight line', () => {
    expect(shouldFitRoute(null, real)).toBe(true);
    expect(shouldFitRoute(null, straight)).toBe(true);
  });

  it('fits when a real road route arrives (recovery or reroute)', () => {
    expect(shouldFitRoute(straight, real)).toBe(true);
    expect(shouldFitRoute(real, eastRoute({ distanceM: 999 }))).toBe(true);
  });

  it('does not re-fit on straight-line refreshes', () => {
    expect(shouldFitRoute(straight, eastRoute({ source: 'fallback', isApproximate: true, distanceM: 1 }))).toBe(false);
    expect(shouldFitRoute(real, straight)).toBe(false);
  });
});
