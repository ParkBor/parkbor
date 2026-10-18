# Habi load tests (k6)

Five k6 scripts that check the guarantees of `docs/ARCHITECTURE.md` (3.2, 10.3, 12, 18) under load.
Expected capacity and what to measure first: `docs/PERFORMANCE.md`.

**Never run these against production.** They create bookings, mint tokens for seed users and hit
the payment webhooks. Use a staging stack that mirrors production (PostGIS, Redis, OSRM, several
Uvicorn workers, nginx) with the provider SANDBOX keys.

| Script | What it proves |
|---|---|
| `booking_contention.js` | N drivers race for the same slot and period: exactly `SLOTS` get 201, the rest 409 `no_slot_available`; same `Idempotency-Key` 3x in parallel gives one booking; replay gives 200 + `Idempotent-Replayed`; same key with another body gives 422 `idempotency_conflict` |
| `nearby_read.js` | `GET /parkings/nearby` at `TARGET_RPS`, p95 under 200 ms |
| `ws_fanout.js` | `POST /ws/ticket` then `wss .../ws/availability/?ticket=` then `subscribe`: time to `ready`, snapshot, pushed events, ticket replay is refused (4401), optional booking churn that produces events |
| `payment_webhook_replay.js` | Payme (JSON-RPC) or Click (md5 form) webhook replayed in parallel: identical answers, booking CONFIRMED once, `paid_amount == amount` |
| `operator_scan_burst.js` | Several operators scan at once: double scan of one entry QR admits once, rescans are no-ops, exit and double exit |

## Requirements

* [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) 0.50 or newer.
* A staging stack with `ALLOWED_HOSTS` containing the host, and (for webhooks) a caller IP that
  passes the payment IP allowlist.
* Python access to the staging backend environment (same DB and same `JWT_SIGNING_KEY`) to run the seed.

## Seeding

Use the existing commands first, then the helper for what they do not cover.

1. Schema and base data (existing commands): `python manage.py migrate`. `seed_parkings` (30 Tashkent lots,
   needs `DEBUG` and `ALLOW_SEED`, so dev settings only) is handy for realistic `nearby` data; on staging it is
   refused, so `nearby_read.js` uses the lots created by the helper instead (add more with `--ws-lots`).
2. The helper `loadtest/seed/loadtest_seed.py` creates, with the project models, drivers (one vehicle each), an owner,
   operators assigned to a gate lot, one fresh lot per scenario and CONFIRMED bookings for the gate, and writes
   long-lived JWTs (`--token-hours`, default 6) to a git-ignored file:

```bash
cd backend
HABI_LOADTEST_SEED=1 HABI_LOADTEST_ALLOW_NONDEBUG=1 \
  python ../loadtest/seed/loadtest_seed.py --drivers 700 --out ../loadtest/.secrets/tokens.json
```

`HABI_LOADTEST_ALLOW_NONDEBUG=1` is only needed when the settings module has `DEBUG` off (staging).
The file holds bearer tokens: keep it out of git and delete it after the run.

**Re-seed before every run** of `booking_contention.js`, `payment_webhook_replay.js` and
`operator_scan_burst.js` (the lots are single-use: bookings from the last run block the slot, and the gate
bookings must start within 20 minutes, `--scan-start-in`, default 15). Use a new `--tag`
(default: timestamp), so lot names stay unique. Cleanup: drop the staging database or delete by name prefix `LT-`
(lots have PROTECT foreign keys, delete bookings and slots first).

### Seed file shape

`drivers[] {token, vehicle_id, user_id}`, `contention {lot_id, slot_type, slots}`, `payments_lot {lot_id}`,
`ws {lot_ids[]}`, `nearby {lat, lng}`, `operator {lot_id, operators[] {token}, scans[] {booking_id, driver_token}}`.

## Running

Paths in `TOKENS_FILE` are relative to the `loadtest/` directory (k6 resolves `open()` from the script).
Secrets and hosts come only from `-e` or the environment, nothing is hardcoded.

```bash
cd loadtest
export BASE_URL=https://staging.example TOKENS_FILE=.secrets/tokens.json

k6 run -e RACERS=200 -e SLOTS=1 booking_contention.js
k6 run -e TARGET_RPS=300 -e HOLD=5m nearby_read.js
k6 run -e VUS=500 -e HOLD_SECONDS=60 -e CHURN_USERS=5 ws_fanout.js
k6 run -e PROVIDER=payme -e PAYME_KEY=... -e VUS=10 -e ITERATIONS=3 payment_webhook_replay.js
k6 run -e PROVIDER=click -e CLICK_SECRET=... -e CLICK_SERVICE_ID=... payment_webhook_replay.js
k6 run -e SCANS=100 operator_scan_burst.js
```

k6 exits non-zero when a threshold fails, so the scripts can gate a CI job.

### Environment variables

| Variable | Default | Used by |
|---|---|---|
| `BASE_URL` (required), `WS_URL` | `BASE_URL` with `ws` scheme | all |
| `TOKENS_FILE` (required) | | all |
| `P95_NEARBY_MS` / `P99_NEARBY_MS` | 200 / 500 | nearby |
| `P95_BOOKING_MS` / `P99_BOOKING_MS` | 500 / 1500 | contention |
| `P95_TICKET_MS`, `P95_WS_READY_MS` | 300, 1000 | ws |
| `P95_WEBHOOK_MS` | 500 | payments |
| `P95_SCAN_MS` | 400 | operator |
| `MAX_ERROR_RATE` | 0.01 | all (5xx, network, unexpected status) |
| `MAX_THROTTLED_RATE` | 0.01 | nearby, operator (429 means too few users) |
| `RACERS`, `SLOTS`, `DUPLICATES`, `START_OFFSET_MIN`, `DURATION_MIN` | 100, seed, 3, 120, 120 | contention |
| `TARGET_RPS`, `RAMP`, `HOLD`, `SPREAD_DEG`, `NEARBY_THROTTLE_PER_MIN` | 100, 1m, 5m, 0.08, 120 | nearby |
| `VUS`, `HOLD_SECONDS`, `TICKET_REPLAY_EVERY`, `CHURN_USERS`, `CHURN_PER_MIN` | 200, 60, 10, 0, 6 | ws |
| `PROVIDER`, `PAYME_KEY`, `PAYME_LOGIN`, `CLICK_SECRET`, `CLICK_SERVICE_ID`, `REPLAYS`, `ITERATIONS` | payme, -, Paycom, -, -, 5, 3 (max 4) | payments |
| `SCANS`, `PACE` | all seeded, 1 | operator |

Thresholds (pass criteria):

* contention: `booking_created count == min(SLOTS, RACERS)`, `booking_double_win == 0`, `booking_unexpected == 0`,
  `checks rate == 1`, `booking_create_ms p95 < P95_BOOKING_MS`.
* nearby: `nearby_ms p95/p99`, `nearby_errors < MAX_ERROR_RATE`, `nearby_throttled < MAX_THROTTLED_RATE`.
* ws: `ws_ticket_ms p95`, `ws_ready_ms p95`, `ws_connect_failures < MAX_ERROR_RATE`, `ws_ticket_replay_accepted == 0`,
  `ws_unexpected_close == 0`. `ws_event_lag_ms` is informational (compares the server `ts` with the k6 host clock,
  so it needs NTP-synced hosts).
* payments: `payments_protocol_errors == 0`, `payments_divergent_replays == 0`, `payments_booking_not_confirmed == 0`.
* operator: `scan_double_entry == 0`, `scan_wrong_result == 0`, `scan_ms p95`, 503 and 429 rates.

## Throttles decide how many users you need

All limits are per user (`DEFAULT_THROTTLE_RATES`), so the load needs many tokens: `nearby` is 120/min per user
(2 req/s), so 1000 RPS needs at least 600 users; `booking_create` 10/min; `ws_ticket` 30/min and 5 sockets per
user; `operator_scan` 60/min per operator (about 11 complete scans a minute each). The scripts refuse to start
with too few tokens instead of silently measuring the throttle. Throttle counters live in Redis (prod/dev cache);
make sure staging uses the same cache backend as production.

## Server-side proof after `booking_contention.js`

The client counts can only show symptoms. Confirm in the database that no two live bookings overlap on a slot:

```sql
SELECT a.id, b.id
FROM bookings_booking a
JOIN bookings_booking b ON a.slot_id = b.slot_id AND a.id < b.id AND a.period && b.period
WHERE a.status IN ('PENDING_PAYMENT','CONFIRMED','ACTIVE','OVERSTAY')
  AND b.status IN ('PENDING_PAYMENT','CONFIRMED','ACTIVE','OVERSTAY');
-- must return 0 rows (the booking_no_overlap EXCLUDE constraint makes that physically so)
```

Also watch while it runs: `pg_stat_activity` waits (`lock` wait events), Postgres log lines `deadlock detected`,
`lock_timeout` / `serialization_retry` 503s in the API log (expected to be rare and never a duplicate booking).

## Related backend tests (real services)

`backend/tests/concurrency/` repeats the same guarantees as pytest (50 parallel bookings against real EXCLUDE
constraints, plate overlap, a genuine deadlock retried by the service layer, Idempotency-Key and WebSocket ticket
races and the connection-registry Lua script on a real Redis). They are marked `postgis` / `redis`, are skipped
without the services, and CI sets `REQUIRE_POSTGIS=1` / `REQUIRE_REDIS=1`:

```bash
REQUIRE_POSTGIS=1 REQUIRE_REDIS=1 REDIS_TEST_URL=redis://localhost:6379/5 pytest tests/concurrency
```

`REDIS_TEST_URL` must use a throw-away database other than 0 (the fixtures call `flushdb`).
