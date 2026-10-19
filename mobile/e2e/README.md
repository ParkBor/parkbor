# ParkBor mobile E2E (Maestro)

End-to-end flows for the Expo app, written for [Maestro](https://maestro.mobile.dev). They drive the
real app against a real (local or staging) backend.

> **Status: written, statically validated, never executed.** When this suite was created there was no
> Maestro CLI, no Android emulator/iOS simulator, no EAS build and no running backend on the authoring
> machine. What *was* checked: every YAML file parses, uses only known Maestro commands, references
> files that exist and `id:` selectors that are listed in `TESTID_REQUESTS.md`
> (`pnpm --filter mobile e2e:validate`); the JS helper scripts pass `node --check`; the Python hook
> server passes `py_compile`. Selectors, timings, OS-dialog texts and the hook server's calls into the
> backend are **unverified assumptions**. Expect a first-run debugging pass. See "Unverified" at the end.

## Layout

```
mobile/e2e/
  config.yaml            Maestro workspace: runs flows/*
  flows/                 16 runnable flows (tags: smoke | full | android | security | needs-testids | needs-hook)
  subflows/              launch_fresh, login_as, login_seeded, login_new_user, onboarding_new_user,
                         open_lot_detail, connect_dev_client, assert_safe_landing
  scripts/               Maestro JS (hook_call, new_identity, seed_identity, expect_one_less),
                         validate_flows.py, run_local.sh, ci_run_maestro.sh
  helpers/e2e_hook_server.py   test-only server that plays Telegram + the payment provider
  e2e.env.example        copy to .env.e2e
  TESTID_REQUESTS.md     what the mobile agent must add (testIDs, +not-found, e2e build profile)
```

## Flows

| # | File | Tags | What it proves | Seed accounts |
|---|---|---|---|---|
| 01 | `01_first_launch_language_onboarding_permissions` | smoke, needs-testids, needs-hook | cold start, 3 slides (+ "Skip" absent on the last), language switch uz/ru/en on the login screen, new-account bot-code login, name validation, first vehicle, location and notification OS prompts, lands on the map | none (new account) |
| 02 | `02_login_bot_code` | smoke, needs-hook | code refused before the bot confirmed, wrong code with "Attempts left: 4", correct code signs in | driver 0 |
| 03 | `03_map_lots_detail` | smoke, needs-hook | map tab -> nearby list -> lot detail with "free / total" per spot type | driver 0 |
| 03b | `03b_live_availability` | full, needs-hook | detail screen count drops by one when another driver books (WebSocket, polling fallback) | driver 0, booker driver 5 |
| 04 | `04_vehicle_plate_validation` | full, needs-testids, needs-hook | plate too short / digits only / symbols, duplicate refused by the server, valid plate listed formatted | none (new account) |
| 05 | `05_booking_payment_qr` | smoke, needs-testids, needs-hook | slot type + period -> "Pay and book" -> payment screen -> payment confirmed -> booking CONFIRMED with QR | none (new account) |
| 06 | `06_cancel_booking_refund_preview` | full, needs-hook | refund preview, "No, keep it" changes nothing, "Yes, cancel" -> Cancelled | driver 1 |
| 07 | `07_notifications_soft_prompt_and_settings` | full, needs-hook | soft prompt after paid, "Not now" does not open the OS dialog, settings shows off, enabling it turns it on | driver 6 |
| 07b | `07b_notifications_soft_prompt_accept` | full, needs-hook | accepting the soft prompt -> OS dialog -> settings shows on | driver 6 |
| 08 | `08_operator_checkin_exit_manual_qr` | full, needs-hook | operator entry via manual QR, replay refused, exit (and cash step if the lot bills) | operator 0, gate booking `E2E_SCAN_INDEX` |
| 09 | `09_operator_walkin_checkout_cash` | full, needs-testids, needs-hook | walk-in, manual exit, two-step cash "Cash taken" | operator 1 |
| 09b | `09b_operator_checkout_cash_deferred` | full, needs-testids, needs-hook | same, "Later (debt)" | operator 2 |
| 10 | `10_offline_qr_cache` | full, android, needs-hook | QR served from the device copy with airplane mode on | driver 2 |
| 11 | `11_logout_clears_data` | smoke, needs-hook | logout, relaunch stays signed out, next account cannot open the previous booking | drivers 4 and 7 |
| 12 | `12_deeplink_booking_valid` | smoke, needs-hook | `parkbor://booking/<uuid>` warm and (plain builds) cold, upper-case id, signed-out guard, payment return link without id | driver 3 |
| 13 | `13_deeplink_hostile` | full, security, needs-hook | `not-a-uuid`, `..`, `%2e%2e`, `<uuid>/cancel`, `parkbor://evil`, scheme smuggling, `status=success` in the payment link, `https://` link | driver 3 |

"needs-testids": fails until section A of `TESTID_REQUESTS.md` is implemented. "needs-hook": needs the
hook server below. Run only what works today with
`maestro test --exclude-tags=needs-testids ...`.

Selector policy: English accessibility labels / visible text (Maestro matches Android `content-desc`
and iOS `label`), `id:` only where the request file says text is ambiguous. The language is forced to
English by tapping the "English" button on the login screen; **the welcome slides follow the device
locale, so set the device to en-US** (flow 01 asserts the English slide texts).

## Test-only login path (real Telegram cannot be automated)

The app's login is: `POST /auth/telegram/start` -> opens `t.me/<bot>?start=<token>` -> user shares the
phone in the bot -> bot shows a 6-digit code -> the user types it -> `POST /auth/telegram/verify`.

The flows run **exactly that path in the app**. Only the Telegram side is replaced:
`login_as.yaml` taps "Sign in with Telegram", brings the app back to the foreground (the t.me link
opens a browser/Telegram), then calls the hook server `POST /login-code {telegram_id}`. The server finds
the newest pending `tglogin:*` Redis session and calls `login_service.confirm_contact(...)` for that
Telegram id, which is what the bot webhook does after the contact share, and returns the code. The flow
types it into the app. New Telegram ids (9_300_000_000+) create new accounts; seeded ids log in as the
seeded drivers/operators.

Consequences: no credential-accepting code in the app bundle; the harness depends on backend internals
(`tglogin:` key layout, `confirm_contact`). The app needs nothing new (TESTID_REQUESTS.md N3).

## Payment: what is mocked and where the flow stops

- The payment screen loads the provider's checkout in the locked-down WebView (ARCHITECTURE 13.5). The
  URL must pass the host allowlist (`checkout.paycom.uz`, `my.click.uz`; `test.paycom.uz` only in
  dev/sandbox builds against a local/staging API). For a backend with `PAYMENTS_SANDBOX=true` and a
  dummy `PAYME_MERCHANT_ID` it builds such a URL; whether the sandbox page itself loads depends on the
  network and is **not asserted**.
- 3-D Secure/bank (ACS) domains are blocked by the allowlist **by design**. Flow 05 therefore never
  pays inside the WebView. It stops at the pay screen (asserts header, "Check payment status", "Cancel
  payment", the `payment-webview` container), then the hook server `POST /pay-latest` performs what the
  provider webhook would (`register_transaction` + `complete_payment`), and the flow taps "Check payment
  status". Flows 07 and 07b use the provider return link `parkbor://payment/result?id=<uuid>` instead. In
  both cases the app reads the result from the server (the link status is never trusted, and flow 13
  asserts that).
- To cover the real in-page redirect, someone must measure the sandbox's 3-D Secure hosts first.

## Operator without a camera

CI cannot feed a camera. Flow 08 denies camera permission and uses the production field
"Enter the QR by hand" on the scan screen with a real token: the hook server `POST /qr {scan_index}`
reads `GET /bookings/<id>/qr` with the seeded driver's token (the entry token before check-in, the exit
token after it). No test-only app path is needed.

## Prerequisites

- Node/pnpm as in the repo, Python 3.12 with the backend requirements (for the seed and hook server),
  Docker (Postgres/PostGIS + Redis), JDK 17.
- Maestro CLI. Install from the official instructions and **pin a version** (this suite was written
  without ever running one; it uses `runFlow`, `runScript`, `evalScript`, `setLocation`,
  `setAirplaneMode`, `copyTextFrom`, `onFlowComplete`, the JS `http`/`json`/`output` globals). Check
  `maestro --version` against the Maestro release notes if a command is rejected.
- Android: Android Studio emulator, API 34 (any image: the map is MapLibre with OpenStreetMap vector tiles, no Google
  Play services needed; the emulator needs internet access to load the map style), locale en-US, animations off:
  `adb shell settings put global window_animation_scale 0` (same for `transition_animation_scale`,
  `animator_duration_scale`). API 33+ is required for the notification flows (07/07b): older Android
  grants notifications at install, so no soft prompt appears.
- iOS: Xcode simulator (iOS 17+), locale en-US. `setAirplaneMode` does not exist there: flow 10 is
  tagged `android`; run `pnpm --filter mobile e2e:ios` (= `--exclude-tags=android`).

## 1. Backend stack

```bash
docker compose up -d db redis                 # as in CLAUDE.md
cd backend
export DJANGO_SETTINGS_MODULE=config.settings.dev
export PAYMENTS_SANDBOX=true PAYME_MERCHANT_ID=000000000000000000000000   # dummy: only builds the checkout URL
export PAYMENTS_RETURN_URL=parkbor://payment/result
export QR_SIGNING_KEY=$(openssl rand -hex 32)                              # if your dev settings need one
python manage.py migrate
python manage.py runserver 0.0.0.0:8000        # ASGI runserver (Channels) for the WebSocket
```

## 2. Seed data (reuses `loadtest/seed/loadtest_seed.py`)

```bash
cd backend
HABI_LOADTEST_SEED=1 python ../loadtest/seed/loadtest_seed.py \
  --drivers 20 --operators 3 --scans 20 --scan-start-in 15 --tag e2e \
  --out ../loadtest/.secrets/tokens.json         # git-ignored; holds live bearer tokens, delete after the run
```

It creates (names carry the `--tag`): `LT-payments-e2e` (400 STANDARD slots, tariff 6000/h),
`LT-ws0..2-e2e` (20 slots each), `LT-gate-e2e` (one slot per scan booking, operators assigned),
drivers with Telegram ids `9_100_000_000 + i` (each with plate `LT0000iAB`), operators
`9_200_000_000 + i`, and `--scans` CONFIRMED gate bookings starting `--scan-start-in` minutes from
now. Accounts used by the flows: **drivers 0-7, operators 0-2, gate booking index `E2E_SCAN_INDEX`**.

Things that bite:

- **Gate bookings expire.** Entry opens 30 min before the start and the booking becomes NO_SHOW 20
  min after it (ARCHITECTURE 6.3/10.7). Seed right before flow 08. Each gate booking can be checked in
  once: pass a new `E2E_SCAN_INDEX` per run (or re-seed with a new `--tag`).
- **Booking limits and leftovers.** The hook creates bookings for drivers 1-6 on every run; they pile up
  until the per-user booking limit. Re-seed with a new `--tag` (and new lot names) when a flow reports
  `booking_limit_reached`.
- **Walk-in cash (flows 09/09b)** is data dependent: a stay of a few seconds only produces a cash due if
  the tariff has no free minutes / has a minimum charge. When the due is 0 the flow takes the
  "Car released" branch and says so in the screenshot name. Seed such a tariff to force the cash step.
- Lot visibility on the map needs the seed's Tashkent coordinates (41.31, 69.28); the flows also call
  `setLocation` for that point.

## 3. Hook server

```bash
cd backend
HABI_E2E_HOOK=1 \
HABI_E2E_HOOK_KEY=<16+ random chars> \
HABI_E2E_SEED_FILE=../loadtest/.secrets/tokens.json \
HABI_E2E_API=http://127.0.0.1:8000/api/v1 \
python ../mobile/e2e/helpers/e2e_hook_server.py --port 8765
```

It refuses to start without `HABI_E2E_HOOK=1`, a 16+ character key, and a DEBUG settings module
(staging needs `HABI_E2E_ALLOW_NONDEBUG=1`), binds 127.0.0.1 only, compares the `X-E2E-Key` header in
constant time and does not log bodies. **Never run it where real users exist**: it mints logins for
arbitrary Telegram ids. Endpoints: `/login-code`, `/pay-latest`, `/paid-booking`, `/qr`, `/health` (see
the module docstring).

## 4. The app

### Android emulator, EAS development build + Expo dev client (the current `eas.json`)

```bash
cd mobile
eas build --profile development --platform android      # or: npx expo run:android
# Preferred for CI and cold-start/relaunch flows: no Metro, no dev menu:
#   eas build --profile e2e --platform android              (APK)
#   eas build --profile e2e-ios-simulator --platform ios     (simulator .app)
# With an e2e build leave E2E_DEV_CLIENT unset/false and skip Metro; keep the adb reverse for :8000.
adb install path/to/habi-development.apk
pnpm --filter mobile start --dev-client                  # Metro on :8081
adb reverse tcp:8081 tcp:8081
adb reverse tcp:8000 tcp:8000                            # the build's API/WS URL is localhost:8000
```

Run with `E2E_DEV_CLIENT=true` and `E2E_METRO_URL=http://10.0.2.2:8081` (or `http://localhost:8081`
with the `adb reverse` above). `subflows/connect_dev_client.yaml` opens
`exp+parkbor://expo-development-client/?url=...` after every cold start. Dev-client caveats: the dev menu
overlay can cover buttons (dismiss it once by hand and keep "Show menu on launch" off), a cold start
by link (flow 12 part) and `launchApp` relaunches go through the launcher, and `__DEV__` is true (so
the payment sandbox rule passes because of the dev client). A release-style `e2e` build avoids all
that: see TESTID_REQUESTS.md N2.

### iOS simulator

```bash
cd mobile
npx expo run:ios          # local simulator build; the development profile has no `ios.simulator: true`
pnpm --filter mobile start --dev-client
```

(`eas build --profile development --platform ios` produces a device build unless the profile gets
`"ios": { "simulator": true }`; see N2.) Use `E2E_DEV_CLIENT=true E2E_METRO_URL=http://localhost:8081`.
The simulator reaches the host's `localhost:8000` directly. The iOS keychain survives reinstall:
`launch_fresh.yaml` runs `clearKeychain` on iOS.

## 5. Run

```bash
cp mobile/e2e/e2e.env.example mobile/e2e/.env.e2e      # fill E2E_HOOK_KEY, lot names, E2E_SCAN_INDEX
pnpm --filter mobile e2e:validate                       # static check, no device
bash mobile/e2e/scripts/run_local.sh --include-tags=smoke
bash mobile/e2e/scripts/run_local.sh --exclude-tags=needs-testids       # what can work before the testIDs land
bash mobile/e2e/scripts/run_local.sh mobile/e2e/flows/02_login_bot_code.yaml   # one flow: pass the file instead of the directory
```

(`run_local.sh` runs the whole directory unless a `*.yaml` argument is given.)
Direct form: `maestro test -e E2E_HOOK_KEY=... -e E2E_PAY_LOT_NAME=LT-payments-e2e -e E2E_WS_LOT_NAME=LT-ws0-e2e -e E2E_GATE_LOT_NAME=LT-gate-e2e --include-tags=smoke mobile/e2e`.
Screenshots and logs land in `~/.maestro/tests/` (or `--test-output-dir`).

## CI

`.github/workflows/mobile.yml`: job `e2e-android` runs only on `workflow_dispatch` (input `apk_url`,
input `tags`) and a weekly schedule that needs the repository variables `E2E_APK_URL` and
`MAESTRO_VERSION`. It never runs on push/PR and does not gate them (the existing `lint-test` job now
carries an `if` so the manual/scheduled triggers do not run it too, and the concurrency group includes
the event name so a manual run does not cancel a push run). `lint-test` additionally runs
`pnpm --filter mobile e2e:validate` (static, no device). The e2e job starts Postgres/Redis, migrates,
seeds, starts the API and hook server, installs the pinned Maestro, installs the APK on an API 34
emulator and runs `scripts/ci_run_maestro.sh`; it uploads JUnit XML, Maestro artifacts and server logs.
**That job has never run.** It also needs the `e2e` EAS profile (N2) and an APK URL reachable from the runner.

## Unverified (read before trusting a green or red run)

1. Nothing was executed: no Maestro, emulator, simulator or backend ran. Flow timings and selectors are guesses.
2. Maestro behaviours assumed: `output` shared between a flow and its `runFlow` subflows; case-insensitive
   full-match regex on text; `text` matching Android `content-desc`/iOS `label` of `Pressable`s;
   `below:` relative selector; `evalScript` with a single assignment; `onFlowComplete`; `permissions:
   {notifications: unset}` on Android 13+; `setLocation`; `clearKeychain` being a no-op on Android; the
   JS `http.post(url, {headers, body})` API and `json()`.
3. OS permission dialog texts ("While using the app", "Allow") vary by Android/iOS version and OEM image.
4. Native `Alert` buttons are matched by text ("Not now", "Allow", "Release"); button case on Android may differ.
5. Hook server: written against the code read in `apps/telegram_bot/login_service.py`,
   `apps/payments/services.py` and the booking API as used by the mobile client; it was not run. Open
   points: the dev settings may require `QR_SIGNING_KEY`; a phone number format/uniqueness rule could
   reject `+998<id>`; `register_transaction`/`complete_payment` may publish realtime/notification events
   that need workers; the payments app may refuse `PAYMENTS_SANDBOX` without more provider settings.
6. The payment WebView page itself (sandbox availability, redirects, 3-D Secure hosts) is not covered.
7. Cyrillic plate input, the camera scanner, push delivery and real Telegram are not covered. Operator
   join by invite code, extend booking, route/navigation screens and map marker tapping are not covered either.
8. Cold-start-by-link (flow 12) and relaunch flows are unreliable under the dev client.
9. Flow 13 documents today's behaviour for unknown paths (router's default Unmatched Route page); N1 asks for a proper not-found route.
