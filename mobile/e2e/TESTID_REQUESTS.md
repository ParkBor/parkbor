# Requests to the mobile agent (testIDs and small app changes)

**STATUS: the mobile agent has implemented sections A, B, N1 and N2 (testID props on Button/Chip/PlateField, all ids below, `+not-found` with `not-found-back`, EAS profiles `e2e` and `e2e-ios-simulator`). Re-verify against the code before relying on it; nothing has been run on a device.** Sections are kept as the original request.

The E2E agent may not edit `mobile/src` or `mobile/app`. The app has **no `testID` anywhere today**.
Most elements are reachable through their English `accessibilityLabel` (Maestro matches it as text on
Android `content-desc` and iOS `label`), so the flows use text for buttons, chips and uniquely
labelled inputs. The elements below cannot be addressed reliably that way (duplicate labels,
unlabelled containers, or a native control that needs a stable handle).

`mobile/e2e/scripts/validate_flows.py` checks that every `id:` used by a flow is listed in this file.
Flows tagged `needs-testids` fail until the items in section A exist.

## A. Required `testID`s (flows use these)

`Button` and `Chip` (`src/components/Button.tsx`, `Chip.tsx`) need an optional `testID?: string` prop
passed to the `Pressable`. React Native maps `testID` to the Android resource-id and the iOS
`accessibilityIdentifier`, which is what Maestro `id:` matches.

| testID | Where | Why text does not work |
|---|---|---|
| `profile-first-name` | `app/(auth)/complete-profile.tsx`, the first-name `TextInput` | A `Text` with the same string "First name" sits next to the input; a tap on the label does not focus the field. |
| `vehicle-plate-input` | `src/features/vehicles/VehicleFields.tsx`, the plate `TextInput` (used by the onboarding first vehicle and `vehicles/edit`) | Same: label `Text` "Plate number" plus input `accessibilityLabel` "Plate number"; also the placeholder. |
| `walkin-plate-input` | `src/features/operator/PlateField.tsx` as used by `WalkInScreen` (add a `testID` prop to `PlateField`; pass `walkin-plate-input` from `WalkInScreen`; the scan screen may use `scan-plate-input`) | Same duplicate-label problem. |
| `permissions-allow-location` | `app/(auth)/permissions.tsx`, the "Allow" `Button` of the location `PermissionRow` | Both rows render a button labelled "Allow". |
| `permissions-allow-notifications` | same file, notifications row "Allow" button | same |
| `payment-webview` | `src/features/payment/PaymentWebView.tsx`, root `View` (the one that already has `accessibilityLabel` "Payment page") | Needed to assert the pay page is mounted without reading the third-party page; a labelled container is not always exposed as its own node on iOS. |

## B. Recommended `testID`s (not used by the current flows; they make later flows locale independent)

| testID | Where |
|---|---|
| `code-input` | `src/features/auth/CodeCells.tsx` hidden `TextInput` (the flows rely on its `autoFocus`). |
| `map-screen` | root `View` of `src/features/map/MapScreen.tsx`. |
| `tab-map`, `tab-bookings`, `tab-profile`, `tab-operator` | `tabBarButtonTestID` in `app/(tabs)/_layout.tsx`. |
| `booking-submit` | the "Pay and book" button in `SubmitSection.tsx`. |
| `booking-qr` | the QR `View` in `QrPanel.tsx` (today only `accessibilityLabel` "Booking QR code"). |
| `operator-qr-manual-input` | manual QR `TextInput` in `ScanScreen.tsx` (today unique label "QR code text"). |
| `logout-button` | the log out button in `app/(tabs)/profile.tsx`. |

Native `Alert.alert` dialogs (soft notification prompt, "Release the car?") cannot carry a `testID`;
the flows match their button text ("Not now", "Allow", "Release"). Keep those strings stable or tell
the E2E agent when they change.

## C. Other changes the flows depend on

- **N1. `app/+not-found.tsx` (security finding).** There is no not-found route. `parkbor://evil`,
  `parkbor://booking/../x` and similar hostile links therefore end on expo-router's default "Unmatched
  Route" page. Nothing private is shown, but the page has no way back into the tabs for a signed-in
  user and no i18n. Please add a `+not-found.tsx` that redirects to `/(tabs)` (signed in) or the
  welcome screen. Flow `13_deeplink_hostile` accepts either behaviour today and walks back with
  `parkbor:///`.
- **N2. EAS build profile `e2e`** (owner of `eas.json`; the E2E agent may not touch it). Same env as
  `development` (`EXPO_PUBLIC_API_URL=http://localhost:8000/api/v1`, `EXPO_PUBLIC_WS_URL=ws://localhost:8000/ws`,
  `EXPO_PUBLIC_PAYMENT_SANDBOX=true`) but `developmentClient: false`, `android.buildType: apk`,
  `distribution: internal`. A release-style APK needs no Metro server and no dev menu overlay, and
  makes cold-start deep-link flows (12) and relaunch flows (11) reliable. For the iOS simulator add
  a sibling profile with `ios.simulator: true` (the current `development` profile builds for devices). Cleartext HTTP is allowed
  because `app.config.ts` only disables it when `EAS_BUILD_PROFILE=production` or
  `APP_ENV=production`; do NOT name the profile `production`. Note `__DEV__` is false in such a build,
  so the payment sandbox then depends on `EXPO_PUBLIC_PAYMENT_SANDBOX=true` plus a local API host
  (`localhost`, `127.0.0.1`, `10.0.2.2`): keep the profile on those hosts.
- **N3. Test-only login path: nothing is required in the app.** The production flow is
  start -> bot confirms -> 6-digit code -> verify. The test harness plays the bot server-side
  (`helpers/e2e_hook_server.py`), so the app runs its real code path and no token-injection code
  ships in the bundle. This does couple the harness to the backend internals
  `apps.telegram_bot.login_service` (`tglogin:*` Redis layout, `confirm_contact`). If the backend
  agent changes them, the hook server must change with them. A dev-build-only "seeded token via
  env" path in the app is deliberately NOT requested: it would put a credential-accepting code path
  in a build that talks to a real API.
- **N4. Operator manual QR entry already exists** in production code (`Enter the QR by hand`,
  `ScanScreen.tsx`), so camera-less operator flows need no test-only path. Keep it.
- **N5. Payment WebView.** No hook to force the provider redirect. The flows complete payments
  server-side and return through "Check payment status" or `parkbor://payment/result?id=<uuid>`. If
  the team wants the real in-WebView redirect covered, the sandbox page must be reachable from CI
  and its 3-D Secure hosts measured first (`THREE_DS_HOSTS` is empty, ARCHITECTURE 13.5).
