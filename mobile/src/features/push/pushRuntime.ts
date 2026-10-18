import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { createDeviceRegistrar } from '@/features/push/deviceRegistrar';
import { currentPushToken } from '@/features/push/logoutToken';
import { parsePermission, type PermissionState, type PushPermission } from '@/features/push/permissionPolicy';
import { api } from '@/lib/api';

/**
 * Expo push glue (expo-notifications, expo-device, the HTTP client). Not unit tested: it is
 * wiring of tested logic to native modules and needs a real device (see the Step 10b report).
 */

export const ANDROID_CHANNEL_ID = 'default';

/** Foreground: show the banner (no sound); the app also refreshes its booking data on receipt. */
export function configureForegroundNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/** Android 13+ shows the permission dialog only once a channel exists. */
export async function ensureAndroidChannel(name: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

export async function readPermission(): Promise<PushPermission> {
  try {
    return parsePermission(await Notifications.getPermissionsAsync());
  } catch {
    return { state: 'denied', canAskAgain: false };
  }
}

/** Shows the OS dialog. Call only from a user-meaningful moment (permissionPolicy). */
export async function requestPermission(): Promise<PermissionState> {
  try {
    return parsePermission(await Notifications.requestPermissionsAsync()).state;
  } catch {
    return 'denied';
  }
}

function easProjectId(): string | null {
  const extra: unknown = Constants.expoConfig?.extra;
  const fromExtra = (extra as { eas?: { projectId?: unknown } } | undefined)?.eas?.projectId;
  const id = typeof fromExtra === 'string' ? fromExtra : Constants.easConfig?.projectId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function readExpoPushToken(): Promise<string | null> {
  // Simulators and emulators without Play Services cannot receive push; so does a build with no EAS project.
  const projectId = easProjectId();
  if (!Device.isDevice || projectId === null) return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

export const deviceRegistrar = createDeviceRegistrar({
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  getPermission: async () => (await readPermission()).state,
  getToken: readExpoPushToken,
  register: async (platform, token) => {
    await api.post('/me/devices', { platform, expo_push_token: token });
  },
  // Registered or being registered: the auth store queues it with the logout / forced wipe.
  onCurrentToken: (token) => currentPushToken.set(token),
});

/** Registers this phone for the signed-in user (no-op without permission). */
export async function syncDevice(userKey: string | null): Promise<void> {
  await deviceRegistrar.sync(userKey);
}

/** Foreground returns: at most one check a minute. */
export async function syncDeviceThrottled(userKey: string | null): Promise<void> {
  await deviceRegistrar.syncThrottled(userKey);
}

/** The session ended (the revocation carrying the token is already queued by the auth store). */
export function endDeviceSession(): void {
  deviceRegistrar.endSession();
}
