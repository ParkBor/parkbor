// Search / nearby read load: GET /parkings/nearby at a target request rate.
//
// Target (ARCHITECTURE 3.2 and 18): p95 < 200 ms at 1000 RPS. The endpoint is throttled PER USER
// (nearby = 120/min, i.e. 2 req/s per account), so the run needs at least
// TARGET_RPS / 2 distinct tokens (+20% head-room); the script refuses to start with fewer
// (otherwise it would measure the throttle, not the server).
//
//   k6 run -e BASE_URL=... -e TOKENS_FILE=.secrets/tokens.json -e TARGET_RPS=300 nearby_read.js
//
// Note: /parkings/nearby asks OSRM for road distances. Run it against the staging stack WITH
// the OSRM container, otherwise the number says nothing about production.
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { API, SLO, intEnv, parseSeed, requireTokensFile } from './lib/config.js';
import { authHeaders, requireEnoughUsers } from './lib/http.js';

const seed = parseSeed(open(requireTokensFile()));
const drivers = new SharedArray('drivers', () => seed.drivers);
const centre = seed.nearby || { lat: 41.3111, lng: 69.2797 }; // Tashkent

const TARGET_RPS = intEnv('TARGET_RPS', 100);
const PER_USER_RPM = intEnv('NEARBY_THROTTLE_PER_MIN', 120); // settings DEFAULT_THROTTLE_RATES
const SPREAD_DEG = Number(__ENV.SPREAD_DEG || 0.08); // ~9 km around the centre
const RAMP = __ENV.RAMP || '1m';
const HOLD = __ENV.HOLD || '5m';

const throttled = new Rate('nearby_throttled'); // 429: the test lacks users
const serverErrors = new Rate('nearby_errors'); // 5xx, bad body, any status but 200/429
const nearbyMs = new Trend('nearby_ms', true);

const ok = http.expectedStatuses(200, 429);
const RADII = [500, 1000, 2000, 5000];
const SORTS = ['recommended', 'distance'];

export const options = {
  scenarios: {
    nearby: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.floor(TARGET_RPS / 10)),
      timeUnit: '1s',
      preAllocatedVUs: Math.max(20, Math.ceil(TARGET_RPS / 4)),
      maxVUs: Math.max(100, TARGET_RPS * 2),
      stages: [
        { target: TARGET_RPS, duration: RAMP },
        { target: TARGET_RPS, duration: HOLD },
        { target: 0, duration: '15s' },
      ],
    },
  },
  thresholds: {
    nearby_ms: [`p(95)<${SLO.nearbyP95}`, `p(99)<${SLO.nearbyP99}`],
    nearby_errors: [`rate<${SLO.maxErrorRate}`],
    nearby_throttled: [`rate<${SLO.maxThrottledRate}`],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const need = Math.ceil((TARGET_RPS * 60) / PER_USER_RPM / 0.8);
  requireEnoughUsers(drivers.length, need, `nearby_read at ${TARGET_RPS} RPS`);
}

export default function () {
  // spread requests over all tokens, independent of the number of VUs
  const driver = drivers[(__ITER + __VU * 7919) % drivers.length];
  const lat = centre.lat + (Math.random() * 2 - 1) * SPREAD_DEG;
  const lng = centre.lng + (Math.random() * 2 - 1) * SPREAD_DEG;
  const radius = RADII[Math.floor(Math.random() * RADII.length)];
  const sort = SORTS[Math.floor(Math.random() * SORTS.length)];
  const url = `${API}/parkings/nearby?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&radius=${radius}&limit=20&sort=${sort}`;

  const res = http.get(url, {
    headers: authHeaders(driver.token),
    tags: { name: 'parkings_nearby' },
    responseCallback: ok,
  });

  if (res.status === 429) {
    throttled.add(1);
    return;
  }
  throttled.add(0);
  nearbyMs.add(res.timings.duration);
  const good = check(res, {
    'nearby is 200': (r) => r.status === 200,
    'nearby returns JSON': (r) => {
      try {
        return r.json() !== null;
      } catch (_e) {
        return false;
      }
    },
  });
  serverErrors.add(!good);
}
