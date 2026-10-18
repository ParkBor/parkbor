import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useRouter, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState } from 'react-native';

import { bookingKeys } from '@/features/booking/queryKeys';
import {
  bookingIdFromNotificationData,
  createResponseDeduper,
  decidePendingTap,
  type PendingTap,
} from '@/features/push/notificationLink';
import {
  configureForegroundNotifications,
  endDeviceSession,
  ensureAndroidChannel,
  syncDevice,
  syncDeviceThrottled,
} from '@/features/push/pushRuntime';
import { resolveRedirect } from '@/lib/authGuard';
import { onSessionEnd } from '@/lib/sessionEnd';
import { authStore, useAuthStore } from '@/store/auth';
import { useOnboardingStore } from '@/store/onboarding';

configureForegroundNotifications();

/**
 * Root-level push wiring: device registration for the signed-in user (re-registered on token
 * change and, at most once a minute, when the app returns to the foreground), unregistration at
 * session end, foreground refresh of booking data and notification taps -> `/booking/<id>` (only
 * for a valid habi://booking/<uuid>, and only once the auth guard has settled).
 */
export function usePushSetup(): void {
  const { t } = useTranslation();
  const router = useRouter();
  const segments = useSegments();
  const queryClient = useQueryClient();
  const status = useAuthStore((s) => s.status);
  const userId = useAuthStore((s) => (s.status === 'authenticated' && s.user ? String(s.user.id) : null));
  const onboarding = useOnboardingStore((s) => s.step);
  // A tapped booking waits here until it can be opened (see decidePendingTap).
  const pendingRef = useRef<PendingTap | null>(null);
  const openPendingRef = useRef<() => void>(() => undefined);
  const deduper = useRef(createResponseDeduper());

  // The session ending forgets the registration and any tap still waiting (it belonged to that user).
  useEffect(
    () =>
      onSessionEnd(authStore, () => {
        pendingRef.current = null;
        endDeviceSession();
      }),
    [],
  );

  // Register for the signed-in user; keep registered across token changes and foreground returns.
  useEffect(() => {
    if (userId === null) return undefined;
    void ensureAndroidChannel(t('permissions.notificationsTitle')).then(() => syncDevice(userId));
    const tokenSubscription = Notifications.addPushTokenListener(() => void syncDevice(userId));
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncDeviceThrottled(userId);
    });
    return () => {
      tokenSubscription.remove();
      appStateSubscription.remove();
    };
  }, [userId, t]);

  // Foreground receipt: the banner is shown by the handler; the data behind it is refreshed too.
  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const id = bookingIdFromNotificationData(notification.request.content.data);
      if (!id) return; // not a booking push: nothing to refresh
      void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: [...bookingKeys.all, 'list'] });
    });
    return () => subscription.remove();
  }, [queryClient]);

  // Taps (warm and cold start).
  useEffect(() => {
    const handle = (response: Notifications.NotificationResponse | null): void => {
      if (!response || !deduper.current.isNew(response.notification.request.identifier)) return;
      const id = bookingIdFromNotificationData(response.notification.request.content.data);
      if (!id) return;
      pendingRef.current = { id, atMs: Date.now() };
      openPendingRef.current();
    };
    handle(Notifications.getLastNotificationResponse());
    const subscription = Notifications.addNotificationResponseReceivedListener(handle);
    return () => subscription.remove();
  }, []);

  // Open a waiting tap only when signed in, onboarded, and the guard has no redirect left for the
  // current route (otherwise the guard's own router.replace would swallow the screen we push).
  const isGuardSettled = resolveRedirect({ status, segments, onboarding }) === null;
  useEffect(() => {
    openPendingRef.current = () => {
      const decision = decidePendingTap(
        pendingRef.current,
        { isAuthenticated: userId !== null, isOnboardingDone: onboarding === null, isGuardSettled },
        Date.now(),
      );
      if (decision.type === 'wait') return;
      pendingRef.current = null;
      if (decision.type === 'open') router.push({ pathname: '/booking/[id]', params: { id: decision.id } });
    };
    openPendingRef.current();
  }, [userId, onboarding, isGuardSettled, router]);
}
