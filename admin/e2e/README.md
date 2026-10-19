# Admin web E2E (Playwright)

Browser tests of the built admin SPA. There is **no backend**: every `/api/v1/*` request is answered by a typed, in-browser mock (`support/mockApi.ts`, `page.route()`), whose shapes follow `packages/api-client/src/adminOps.ts` and `docs/ARCHITECTURE.md` 9.3.1. The tests prove the panel's behaviour, not the backend's; the backend has its own pytest suite.

## Run

```bash
pnpm install
pnpm --filter admin e2e:install        # one-time: downloads Chromium
pnpm --filter admin e2e                # builds the SPA into e2e/.artifacts/dist, serves it, runs the suite
pnpm --filter admin exec tsc -p e2e/tsconfig.json   # type-check the E2E code
```

Useful switches: `E2E_SKIP_BUILD=1` (reuse the last build), `E2E_PORT=4300`, `E2E_BASE_URL=http://host:port` (test an already running server, no build), `--headed`, `--debug`, `--repeat-each=5` (flakiness check), `--workers=1` on small machines. Reports: `e2e/.artifacts/report` (HTML), `junit.xml` in CI. The build is separate from `admin/dist`.

## How it works

- **Login.** `LoginPage` loads `https://telegram.org/js/telegram-widget.js`. The suite replaces that URL with a stub that renders a button (`data-testid="mock-telegram-login"`) and, on click, evaluates the script tag's `data-onauth` with a fake `user` object, exactly like the real widget. The bot name comes from `VITE_TELEGRAM_BOT_USERNAME`, set by `support/build.mjs`.
- **Memory-only tokens.** A page load drops the session (docs 14.3). After `signIn()` tests move with the menu or `goTo()` (History API), never `page.goto`.
- **Mock API.** One `MockApi` per test (no shared state): seed data in `support/fixtures.ts`, mutable collections, call log (`api.callsTo`), per-test `api.override(method, path, responder)`. An unknown URL answers a plain 404 (no DRF body) like a backend lacking the route.
- **Texts.** Assertions use the panel's own translation tables (`support/i18n.ts`), so wording changes do not break the suite and uz/ru/en are all checked.
- **Selectors.** Roles, accessible names and labels; no CSS except the antd `.ant-select` wrapper (the inner combobox input is covered by the label). The only `data-testid` used is `widget-area` (existing) and the one from the stub.

## Journeys covered

| Spec | Journeys |
|---|---|
| `auth.e2e.ts` | login -> dashboard stats; no token in local/sessionStorage, cookies, URL; reload ends the session; logout revokes; refresh 401 -> login; silent refresh retry; uz/ru/en switch (`html lang`, texts, persisted); 404 without DRF body -> "not available"; chunk 404 -> error boundary |
| `rbac.e2e.ts` | OWNER: no admin-only menu entries, 403 screen on `/users /settings /audit /moderation`, no API call, no Resolve button; ADMIN reaches all; DRIVER/OPERATOR whole-app 403 |
| `bookings.e2e.ts` | list filter (status, plate) sent to the server; detail; cancel dialog with reason, second click while in flight sends nothing (same-instant dblclick is a documented fixme finding), 409 reported, abandoned reason is dropped |
| `refunds.e2e.ts` | MANUAL queue; resolve dialog has no pre-selected outcome; `failed` needs the tick box; sensitive note blocked; 409 stale row refetches; other refusals stay in the dialog |
| `users-operators.e2e.ts` | block / unblock with confirm (and cancel, server refusal); invite code shown once, undismissable by Escape/backdrop, gone after closing and absent from DOM, storage, URL |
| `export.e2e.ts` | `.xlsx` download, unzipped; `=HYPERLINK(...)`, `+1+1`, `@SUM` cells prefixed with `'`, no `<f>` formulas; failing export shows an error |

## Not covered (by design)

Real Telegram widget, real CSP/nginx headers (needs the deployed nginx), the Leaflet map pages (parking create/edit), zones/slots/tariff editors, and anything that depends on real server behaviour (permissions, throttling, data scoping). Those need the backend stack (docker compose) and a separate run.

Note: specs are named `*.e2e.ts` (not `*.spec.ts`) on purpose. The admin's Vitest config (`vite.config.ts`) uses the default include pattern and would otherwise try to run these Playwright files in `pnpm --filter admin test`.
