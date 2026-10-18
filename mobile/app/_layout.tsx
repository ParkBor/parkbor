import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { qrCache } from '@/features/booking/qrStore';
import { bookingKeeper } from '@/features/booking/bookingKeeper';
import { bindKeeperToSession } from '@/features/booking/idempotencyKey';
import { bindQrCacheToSession } from '@/features/booking/qrCache';
import { operatorStore } from '@/features/operator/operatorSession';
import { initPaymentEnv } from '@/features/payment/paymentEnv';
import { PushSetup } from '@/features/push/PushSetup';
import { startRealtime } from '@/features/realtime/realtimeSession';
import { clearLastPayment } from '@/features/payment/lastPayment';
import { initI18n, restoreSavedLanguage } from '@/i18n';
import { resolveRedirect } from '@/lib/authGuard';
import { wireFocus, wireOnline } from '@/lib/queryEnv';
import { onSessionEnd } from '@/lib/sessionEnd';
import { bindQueryClientToSession } from '@/lib/queryLifecycle';
import { authStore, useAuthStore } from '@/store/auth';
import { useOnboardingStore } from '@/store/onboarding';

const styles = StyleSheet.create({ root: { flex: 1 } });

const i18n = initI18n();
initPaymentEnv();
void SplashScreen.preventAutoHideAsync();

function useAuthGuard(): void {
  const router = useRouter();
  const segments = useSegments();
  const status = useAuthStore((s) => s.status);
  const onboarding = useOnboardingStore((s) => s.step);

  useEffect(() => {
    const target = resolveRedirect({ status, segments, onboarding });
    if (target) router.replace(target);
  }, [status, segments, onboarding, router]);

  useEffect(() => {
    if (status !== 'loading') void SplashScreen.hideAsync();
  }, [status]);
}

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());

  useEffect(() => {
    void restoreSavedLanguage();
    void authStore.getState().bootstrap();
  }, []);

  useAuthGuard();

  useEffect(() => {
    // Logout / account switch: cancel in-flight requests and drop every cached response.
    const unbindSession = bindQueryClientToSession(queryClient, authStore);
    // Offline QR copies in the keystore die with the session too (outside the auth store).
    const unbindQr = bindQrCacheToSession(qrCache, authStore);
    // The unresolved booking attempt (Idempotency-Key) must not outlive the session either.
    const unbindKeeper = bindKeeperToSession(bookingKeeper, authStore);
    // The booking last paid (memory only) belongs to that session too.
    const unbindPayment = onSessionEnd(authStore, clearLastPayment);
    // Operator working state (chosen lot, plate switches, mode) never outlives the session.
    const unbindOperator = onSessionEnd(authStore, () => operatorStore.getState().reset());
    // Live free-spot counts, booking status and operator slots over the WebSocket (polling stays as fallback).
    const stopRealtime = startRealtime(queryClient);
    void qrCache.prune();
    // Foreground refetches stale data; connectivity pauses/resumes queries instead of failing them.
    const unwireFocus = wireFocus(
      (listener) => AppState.addEventListener('change', listener),
      (isFocused) => focusManager.setFocused(isFocused),
    );
    onlineManager.setEventListener((setOnline) =>
      wireOnline((listener) => Network.addNetworkStateListener(listener), setOnline),
    );
    return () => {
      unbindSession();
      unbindQr();
      unbindKeeper();
      unbindPayment();
      unbindOperator();
      unwireFocus();
      stopRealtime();
    };
  }, [queryClient]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <I18nextProvider i18n={i18n}>
        {/* In-memory cache only: responses behind auth must never be persisted. */}
        <QueryClientProvider client={queryClient}>
          <StatusBar style="auto" />
          <PushSetup />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="booking/new" options={{ presentation: 'modal' }} />
            {/* A payment in progress is left only through the confirm dialog, never by a swipe. */}
            <Stack.Screen name="booking/pay" options={{ gestureEnabled: false }} />
          </Stack>
        </QueryClientProvider>
      </I18nextProvider>
    </GestureHandlerRootView>
  );
}
