import type { SyncResult } from '@/features/push/deviceRegistrar';

/**
 * Can this install receive push at all? `unavailable` means a granted permission still yields no Expo
 * token (no EAS project id in the build, no FCM credentials on Android, a simulator). The UI then stops
 * promising notifications instead of failing silently.
 */
export type PushAvailability = 'unknown' | 'available' | 'unavailable';

export function nextAvailability(previous: PushAvailability, result: SyncResult): PushAvailability {
  switch (result) {
    case 'registered':
    case 'unchanged':
      return 'available';
    case 'no_token':
      return 'unavailable';
    default:
      // no permission / no session / a failed request / throttled say nothing about the device's ability
      return previous;
  }
}

/** Static part of the check: simulators and builds without an EAS project id can never get a token. */
export function canEverGetToken(input: { isDevice: boolean; hasProjectId: boolean }): boolean {
  return input.isDevice && input.hasProjectId;
}
