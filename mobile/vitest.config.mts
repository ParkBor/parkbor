import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Every listed logic file must stay covered (pure logic, not UI).
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        // Step 9b logic: every operator logic file must reach the bar on its own (vitest globs are
        // aggregated, so one exact-path entry per file; a covered neighbour cannot hide an untested one).
        'src/features/operator/cardLifecycle.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/checkoutFlow.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/gateErrors.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/gateResult.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/inviteCode.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/lotPolicy.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/money.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/operatorApi.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/operatorSchemas.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/operatorStore.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/plateText.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/pollingPolicy.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/scanPolicy.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/slotView.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/tabVisibility.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/operator/walkInForm.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        // Step 10b (realtime + push): one floor per logic file.
        'src/lib/notFound.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/appState.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/frameLimiter.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/rejectPolicy.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/backoff.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/batcher.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/cacheBridge.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/cacheUpdates.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/closePolicy.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/geohash.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/lifecycle.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/pollFallback.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/protocol.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/rateLimit.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/realtimeClient.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/staleFilter.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/realtime/ticket.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/push/deviceRegistrar.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/push/logoutToken.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/push/notificationLink.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/features/push/permissionPolicy.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
      // Logic modules only (incl. thin native wrappers tested with mocks). NOT covered: UI
      // (app/**, src/components, *.tsx hooks/components) - there are no render tests yet.
      include: [
        'src/lib/{errors,http,refresh,authGuard,timeout,urlPolicy,authApi,secureRefreshStorage,deviceId,tokenLock,pendingRevokes}.ts',
        'src/store/{createAuthStore,createOnboardingStore}.ts',
        'src/features/auth/{code,schemas,loginLink,createLoginStore,loginStore}.ts',
        // Map: only the pure logic extracted from the hooks (useNearbyParkings / UserLocation are
        // thin wiring over these and are NOT covered), plus app-level query/maps helpers.
        'src/features/map/{cluster,debounce,filters,format,geo,locationModel,locationWatcher,mapError,markerColor,parkingText,parkingsApi,schemas,search}.ts',
        // Route/navigation: pure logic only. NOT covered: *.tsx (RouteLayer, RouteNotices,
        // NavigationPanels, NavigationScreen), useRoute / useNavigationSession (hook wiring),
        // openExternalNavigator (OS calls) and app/navigate - there are no render tests.
        'src/features/route/{externalNav,instructionText,lotParams,navigationView,rerouting,routeError,routeProgress,routeSchemas,routesApi}.ts',
        'src/lib/{queryEnv,queryLifecycle,notFound}.ts',
        // Step 7b (bookings, vehicles, parking details): pure logic only - "logic coverage, NOT UI".
        // NOT covered: every *.tsx screen/component, the hooks (use*.ts: React wiring),
        // qrStore.ts (SecureStore wrapper), app/** routes and the app/_layout wiring; there are
        // no render tests. bookingApi/vehiclesApi are covered through injected axios clients.
        'src/lib/{contract,failure,loadState,queryEncoding,sessionEnd}.ts',
        'src/features/booking/{bookingApi,bookingDraft,bookingErrors,bookingSchemas,brightness,countdown,deepLink,idempotencyKey,priceRows,qrCache,qrSource,quoteSchemas,quoteState,refundText,serializationRetry,serverClock,statusView,timeSlots,vehicleSlotCompat,whenText}.ts',
        'src/features/vehicles/{schemas,vehicleErrors,vehiclePlate,vehiclesApi}.ts',
        'src/features/parking/parkingView.ts',
        // Step 8b (payments): pure logic only - "logic coverage, NOT UI". NOT covered: PaymentWebView,
        // PaymentScreen, PaymentResultScreen, PayBodies, WebViewNotices, ProviderPicker, RefundNote
        // (*.tsx), the hooks (usePaymentFlow / usePaymentCancel / usePaymentCheck / usePaymentHoldWatch /
        // useWebViewSession / useExitConfirm / useScreenProtection / useProviderChoice / useNowAt /
        // useBookingSubmit: React wiring over the tested logic), paymentEnv (expo-constants glue) and
        // app/booking/pay, app/payment/result. The real WebView and the Payme/Click sandboxes are not exercised here.
        'src/features/payment/{lastPayment,payAvailability,payFlow,paymentPoller,paymentPolling,paymentResult,paymentSandbox,paymentUrl,providerChoice,refundView,webviewPolicy,webviewProps,webviewState}.ts',
        // Step 9b (operator mode): pure logic only - "logic coverage, NOT UI". NOT covered: every *.tsx
        // screen/component (ScanScreen, ScanCamera, GateCardView, CashPanel, SlotsScreen, SlotGrid,
        // SlotDetail, WalkInScreen, ManualExit, JoinScreen, OperatorHomeScreen, PlateField,
        // OperatorHeader), the hooks (use*.ts: React/TanStack wiring), operatorSession (store singleton),
        // feedback (expo-haptics) and slotColors (palette lookup), app/operator/** and (tabs)/operator;
        // there are no render tests. The camera, haptics and the real backend are not exercised here.
        'src/features/operator/{cardLifecycle,checkoutFlow,gateErrors,gateResult,inviteCode,lotPolicy,money,operatorApi,operatorSchemas,operatorStore,plateText,pollingPolicy,scanPolicy,slotView,tabVisibility,walkInForm}.ts',
        // Step 10b: realtime protocol/reconnect logic and push logic - "logic coverage, NOT UI". NOT covered:
        // realtimeSession (WebSocket/AppState/expo-network wiring), useRealtime (hooks), pushRuntime
        // (expo-notifications / expo-device glue), usePushSetup / usePushPrompt / PushSetup (hooks),
        // NotificationSettingsScreen (UI). A real
        // server and a real device are needed to exercise those.
        'src/features/realtime/{appState,backoff,batcher,cacheBridge,cacheUpdates,closePolicy,frameLimiter,geohash,lifecycle,pollFallback,protocol,rateLimit,realtimeClient,rejectPolicy,staleFilter,ticket}.ts',
        'src/features/push/{deviceRegistrar,logoutToken,notificationLink,permissionPolicy}.ts',
        'config/{mapsKey,paymentSandbox}.js',
        'src/i18n/{resolveLanguage,languagePreference}.ts',
        'src/theme/palette.ts',
      ],
    },
  },
});
