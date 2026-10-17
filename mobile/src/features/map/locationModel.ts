import { isValidLatLng, type LatLng } from '@/features/map/geo';

/** Center of Tashkent: used when location permission is denied or the position is unknown. */
export const DEFAULT_CENTER: LatLng = { lat: 41.2995, lng: 69.2401 };

export type LocationState = 'granted' | 'denied' | 'blocked' | 'servicesOff';

export interface PermissionSnapshot {
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
}

export function deriveLocationState(permission: PermissionSnapshot, servicesEnabled: boolean): LocationState {
  if (permission.status !== 'granted') return permission.canAskAgain ? 'denied' : 'blocked';
  return servicesEnabled ? 'granted' : 'servicesOff';
}

/** A cached fix older than this, or less accurate than this, is not shown as "you are here". */
export const MAX_FIX_AGE_MS = 120_000;
export const MAX_FIX_ACCURACY_M = 1000;
/** With permission but no fix yet, wait this long before searching around Tashkent instead. */
export const FIRST_FIX_WAIT_MS = 4000;

export function isUsableFix(fix: { timestamp: number; accuracy: number | null }, nowMs: number): boolean {
  const age = nowMs - fix.timestamp;
  if (age < 0 || age > MAX_FIX_AGE_MS) return false;
  return fix.accuracy !== null && fix.accuracy <= MAX_FIX_ACCURACY_M;
}

export interface ReadinessInput {
  state: LocationState | 'loading';
  hasPosition: boolean;
  /** The first-fix wait budget (FIRST_FIX_WAIT_MS) is spent. */
  hasWaitedForFix: boolean;
}

/**
 * Whether the first nearby search may start. While the permission prompt is open the sheet shows
 * a skeleton (no useless Tashkent query, no misleading "nothing found"); with permission we give
 * the GPS a short moment so the first request is already around the user.
 */
export function isReadyToSearch({ state, hasPosition, hasWaitedForFix }: ReadinessInput): boolean {
  if (state === 'loading') return false;
  if (state === 'granted') return hasPosition || hasWaitedForFix;
  return true;
}

export function resolveCenter(position: LatLng | null): LatLng {
  return position !== null && isValidLatLng(position) ? position : DEFAULT_CENTER;
}
