// Operator scan burst: a gate full of cars. Many operators scan entry QR codes, double-scan,
// then scan exit QR codes (ARCHITECTURE 9.2).
//
// Needs the seed's `operator` block: operator tokens assigned to the lot plus one CONFIRMED
// booking per driver whose start is "now" (check-in window), see loadtest/seed/loadtest_seed.py.
//
// Per scan (iteration):
//   1. TWO parallel check-ins with the same entry QR: exactly one `allowed:true / checked_in`,
//      the other must be `already_checked_in` (200) or a clean 409/503 - never a second entry.
//   2. check-in again: 200 allowed:false already_checked_in.
//   3. driver fetches the exit QR (purpose "exit").
//   4. check-out: 200 allowed:true completed; check-out again: allowed:false already_completed.
//
// Limits: checkin+checkout share operator_scan = 60/min per OPERATOR (5 operator calls per scan),
// so one operator completes at most ~11 scans/min. PACE=1 (default) sleeps to stay under it;
// PACE=0 removes the sleep to measure the throttle (429s are then expected and not failures).
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { API, SLO, intEnv, parseSeed, requireTokensFile } from './lib/config.js';
import { authHeaders, codeOf, jsonOf } from './lib/http.js';

const seed = parseSeed(open(requireTokensFile()));
const operators = new SharedArray('operators', () => seed.operator.operators);
const scans = new SharedArray('scans', () => seed.operator.scans);
const lotId = seed.operator.lot_id;

const SCANS = Math.min(intEnv('SCANS', scans.length), scans.length);
const PACE = intEnv('PACE', 1);
const CALLS_PER_SCAN = 5;
const BUDGET_PER_MIN = 55; // below the 60/min operator_scan throttle

const scanMs = new Trend('scan_ms', true);
const doubleEntry = new Counter('scan_double_entry'); // two allowed:true for one code: must be 0
const wrongResult = new Counter('scan_wrong_result'); // unexpected body/status: must be 0
const throttled = new Rate('scan_throttled');
const retryable = new Rate('scan_retryable_503'); // lock_timeout / serialization_retry
const completed = new Counter('scan_completed');

const ok = http.expectedStatuses(200, 409, 429, 503);

export const options = {
  setupTimeout: '5m',
  scenarios: {
    gate: {
      executor: 'shared-iterations',
      vus: operators.length,
      iterations: SCANS,
      maxDuration: __ENV.MAX_DURATION || '15m',
    },
  },
  thresholds: {
    scan_ms: [`p(95)<${SLO.scanP95}`],
    scan_double_entry: ['count==0'],
    scan_wrong_result: ['count==0'],
    scan_retryable_503: [`rate<${SLO.maxErrorRate}`],
    scan_throttled: [PACE ? `rate<${SLO.maxThrottledRate}` : 'rate<1'],
    checks: ['rate>0.99'],
  },
};

function qr(scan) {
  const res = http.get(`${API}/bookings/${scan.booking_id}/qr`, {
    headers: authHeaders(scan.driver_token),
    tags: { name: 'booking_qr' },
  });
  return res.status === 200 ? jsonOf(res) : null;
}

export function setup() {
  // entry QR codes, fetched up front by the drivers (booking_qr = 30/min per driver)
  const tokens = [];
  for (let i = 0; i < SCANS; i++) {
    const q = qr(scans[i]);
    if (!q || q.purpose !== 'entry') {
      throw new Error(`booking ${scans[i].booking_id}: no entry QR (${JSON.stringify(q)})`);
    }
    tokens.push(q.qr_token);
  }
  return { entry: tokens };
}

function scanCall(path, operator, body, name) {
  const res = http.post(`${API}${path}`, JSON.stringify(body), {
    headers: authHeaders(operator.token),
    tags: { name: name },
    responseCallback: ok,
  });
  scanMs.add(res.timings.duration);
  throttled.add(res.status === 429);
  retryable.add(res.status === 503);
  return res;
}

export default function (data) {
  const index = exec.scenario.iterationInTest;
  const scan = scans[index];
  const operator = operators[(exec.vu.idInTest - 1) % operators.length];
  const started = Date.now();
  const entry = { qr_token: data.entry[index], parking_lot_id: lotId };

  // 1) the same entry code scanned twice at the same instant
  const pair = http.batch([
    {
      method: 'POST',
      url: `${API}/operator/checkin`,
      body: JSON.stringify(entry),
      params: { headers: authHeaders(operator.token), tags: { name: 'checkin' }, responseCallback: ok },
    },
    {
      method: 'POST',
      url: `${API}/operator/checkin`,
      body: JSON.stringify(entry),
      params: { headers: authHeaders(operator.token), tags: { name: 'checkin' }, responseCallback: ok },
    },
  ]);
  let entered = 0;
  pair.forEach((res) => {
    scanMs.add(res.timings.duration);
    throttled.add(res.status === 429);
    retryable.add(res.status === 503);
    const body = jsonOf(res) || {};
    if (res.status === 200 && body.allowed === true && body.result === 'checked_in') entered++;
    else if (res.status === 200 && body.allowed === false && body.result === 'already_checked_in') {
      // the loser of the race
    } else if (res.status === 429 || res.status === 503 || res.status === 409) {
      // throttled, retryable or a clean conflict (already_used / slot_occupied): nothing changed
    } else {
      wrongResult.add(1);
      console.error(`checkin ${res.status} ${codeOf(res)} ${String(res.body).slice(0, 200)}`);
    }
  });
  if (entered > 1) doubleEntry.add(1);
  if (entered === 0) {
    // everything was throttled/retryable: do a plain sequential attempt so the flow can proceed
    const retry = scanCall('/operator/checkin', operator, entry, 'checkin_retry');
    if (retry.status === 200 && (jsonOf(retry) || {}).allowed === true) entered = 1;
  }

  // 2) a later re-scan of the same code is an amber, no-op answer
  const again = scanCall('/operator/checkin', operator, entry, 'checkin_rescan');
  check(again, {
    'rescan is 200 already_checked_in': (r) =>
      r.status === 429 ||
      (r.status === 200 && (jsonOf(r) || {}).allowed === false && (jsonOf(r) || {}).result === 'already_checked_in'),
  });

  if (entered === 0) return;

  // 3) + 4) exit
  const exit = qr(scan);
  if (!exit || exit.purpose !== 'exit') {
    wrongResult.add(1);
    console.error(`no exit QR for ${scan.booking_id}: ${JSON.stringify(exit)}`);
    return;
  }
  const out = { qr_token: exit.qr_token, parking_lot_id: lotId };
  const first = scanCall('/operator/checkout', operator, out, 'checkout');
  const firstBody = jsonOf(first) || {};
  if (first.status === 200 && firstBody.allowed === true && firstBody.result === 'completed') {
    completed.add(1);
  } else if (first.status !== 429 && first.status !== 503) {
    wrongResult.add(1);
    console.error(`checkout ${first.status} ${codeOf(first)} ${String(first.body).slice(0, 200)}`);
  }
  const second = scanCall('/operator/checkout', operator, out, 'checkout_rescan');
  check(second, {
    'second checkout is a no-op (already_completed)': (r) =>
      r.status === 429 ||
      r.status === 503 ||
      (r.status === 200 && (jsonOf(r) || {}).allowed === false && (jsonOf(r) || {}).result === 'already_completed'),
  });

  if (PACE) {
    const target = (CALLS_PER_SCAN + 1) * (60 / BUDGET_PER_MIN) * 1000; // seconds per scan, ms
    const spent = Date.now() - started;
    if (spent < target) sleep((target - spent) / 1000);
  }
}
