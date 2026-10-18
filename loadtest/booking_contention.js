// Booking contention: N drivers race for the SAME slot(s) and the SAME period.
//
// What must hold (ARCHITECTURE 10.3, 18):
//   * exactly SLOTS bookings are created (201), never more  -> no double booking
//   * every other racer gets 409 no_slot_available
//   * the same Idempotency-Key sent 3x in parallel creates ONE booking; the others answer
//     200 + Idempotent-Replayed (done) or 409 idempotency_in_progress (still running)
//   * a later replay of the winner's key returns 200 + the same booking id
//   * the same key with another payload answers 422 idempotency_conflict
//   * latency of POST /bookings stays under P95_BOOKING_MS (500 ms by default)
//
// Run (see README for seeding):
//   k6 run -e BASE_URL=https://staging.example -e TOKENS_FILE=.secrets/tokens.json \
//          -e RACERS=200 -e SLOTS=1 booking_contention.js
// Afterwards run the SQL "no double booking" check from README (the server-side proof).
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { API, SLO, intEnv, parseSeed, requireTokensFile } from './lib/config.js';
import { authHeaders, codeOf, isoMinutes, jsonOf, requireEnoughUsers } from './lib/http.js';

const seed = parseSeed(open(requireTokensFile()));
const drivers = new SharedArray('drivers', () => seed.drivers);
const lot = seed.contention;

const RACERS = intEnv('RACERS', Math.min(drivers.length, 100));
const SLOTS = intEnv('SLOTS', lot.slots || 1);
const DUPLICATES = intEnv('DUPLICATES', 3); // parallel copies of each request (same key)
const START_OFFSET_MIN = intEnv('START_OFFSET_MIN', 120);
const DURATION_MIN = intEnv('DURATION_MIN', 120);
const EXPECTED_WINNERS = Math.min(SLOTS, RACERS);

const created = new Counter('booking_created'); // 201
const lostRace = new Counter('booking_lost_409'); // 409 no_slot_available
const replayed = new Counter('booking_replayed_200'); // 200 + Idempotent-Replayed
const inProgress = new Counter('booking_in_progress_409');
const doubleWins = new Counter('booking_double_win'); // one VU saw two 201s: must stay 0
const unexpected = new Counter('booking_unexpected'); // anything else: must stay 0
const createTime = new Trend('booking_create_ms', true);

const ok = http.expectedStatuses(200, 201, 409, 422);

export const options = {
  scenarios: {
    race: {
      executor: 'per-vu-iterations',
      vus: RACERS,
      iterations: 1,
      maxDuration: __ENV.MAX_DURATION || '3m',
    },
  },
  thresholds: {
    // exactly K winners: not K-1 (a slot was lost) and never K+1 (double booking)
    booking_created: [`count==${EXPECTED_WINNERS}`],
    booking_double_win: ['count==0'],
    booking_unexpected: ['count==0'],
    booking_create_ms: [`p(95)<${SLO.bookingP95}`, `p(99)<${SLO.bookingP99}`],
    checks: ['rate==1'],
    http_req_failed: [`rate<${SLO.maxErrorRate}`],
  },
};

export function setup() {
  requireEnoughUsers(drivers.length, RACERS, 'booking_contention');
  return {
    runId: __ENV.RUN_ID || `${Date.now()}`,
    start: isoMinutes(START_OFFSET_MIN),
    end: isoMinutes(START_OFFSET_MIN + DURATION_MIN),
  };
}

function body(driver, data, endShift) {
  return JSON.stringify({
    parking_lot_id: lot.lot_id,
    slot_type: lot.slot_type || 'STANDARD',
    vehicle_id: driver.vehicle_id,
    start: data.start,
    end: endShift ? isoMinutes(START_OFFSET_MIN + DURATION_MIN + endShift) : data.end,
  });
}

function request(driver, key, payload) {
  return {
    method: 'POST',
    url: `${API}/bookings`,
    body: payload,
    params: {
      headers: authHeaders(driver.token, { 'Idempotency-Key': key }),
      tags: { name: 'booking_create' },
      responseCallback: ok,
    },
  };
}

export default function (data) {
  const driver = drivers[(__VU - 1) % drivers.length];
  const key = `lt-${data.runId}-${__VU}`;
  const payload = body(driver, data, 0);

  // 1) the race, with DUPLICATES identical requests fired together (double tap / retry storm)
  const batch = [];
  for (let i = 0; i < DUPLICATES; i++) batch.push(request(driver, key, payload));
  const responses = http.batch(batch);

  let wins = 0;
  let bookingId = null;
  for (const res of responses) {
    createTime.add(res.timings.duration);
    const code = codeOf(res);
    if (res.status === 201) {
      wins++;
      created.add(1);
      bookingId = (jsonOf(res) || {}).id;
    } else if (res.status === 200 && res.headers['Idempotent-Replayed']) {
      replayed.add(1);
      bookingId = bookingId || (jsonOf(res) || {}).id;
    } else if (res.status === 409 && code === 'no_slot_available') {
      lostRace.add(1);
    } else if (res.status === 409 && code === 'idempotency_in_progress') {
      inProgress.add(1);
    } else {
      unexpected.add(1);
      console.error(`unexpected ${res.status} ${code} ${String(res.body).slice(0, 200)}`);
    }
  }
  if (wins > 1) doubleWins.add(1);

  if (!bookingId) return; // a loser: its key was released, nothing to replay

  // 2) the winner replays the key later: same booking, 200, flagged as a replay
  const replay = http.post(`${API}/bookings`, payload, {
    headers: authHeaders(driver.token, { 'Idempotency-Key': key }),
    tags: { name: 'booking_replay' },
    responseCallback: ok,
  });
  check(replay, {
    'replay is 200': (r) => r.status === 200,
    'replay says Idempotent-Replayed': (r) => !!r.headers['Idempotent-Replayed'],
    'replay returns the same booking': (r) => (jsonOf(r) || {}).id === bookingId,
  });

  // 3) the same key with another period must not be accepted
  const clash = http.post(`${API}/bookings`, body(driver, data, 30), {
    headers: authHeaders(driver.token, { 'Idempotency-Key': key }),
    tags: { name: 'booking_key_clash' },
    responseCallback: ok,
  });
  check(clash, {
    'key reuse with another payload is 422 idempotency_conflict': (r) =>
      r.status === 422 && codeOf(r) === 'idempotency_conflict',
  });
}
