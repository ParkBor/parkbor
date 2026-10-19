// Shared configuration for every ParkBor k6 script. Everything comes from the environment
// (k6 run -e NAME=value ...). Nothing secret and no host is hardcoded here.
import { fail } from 'k6';

function required(name) {
  const value = __ENV[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required (k6 run -e ${name}=...). See loadtest/README.md`);
  }
  return value;
}

function num(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

export const BASE_URL = required('BASE_URL').replace(/\/+$/, '');
export const API = `${BASE_URL}/api/v1`;
export const WS_URL = (__ENV.WS_URL || BASE_URL.replace(/^http/, 'ws')).replace(/\/+$/, '');

// Service levels. Defaults come from docs/ARCHITECTURE.md 3.2 (nearby p95 < 200 ms,
// booking create p95 < 500 ms); the others are starting points, override per environment.
export const SLO = {
  nearbyP95: num('P95_NEARBY_MS', 200),
  nearbyP99: num('P99_NEARBY_MS', 500),
  bookingP95: num('P95_BOOKING_MS', 500),
  bookingP99: num('P99_BOOKING_MS', 1500),
  ticketP95: num('P95_TICKET_MS', 300),
  wsReadyP95: num('P95_WS_READY_MS', 1000),
  webhookP95: num('P95_WEBHOOK_MS', 500),
  scanP95: num('P95_SCAN_MS', 400),
  // share of requests allowed to be 5xx / network errors / unexpected statuses
  maxErrorRate: num('MAX_ERROR_RATE', 0.01),
  // share of requests allowed to hit a per-user throttle (429): a 429 means the TEST has too few
  // users for its rate, not that the server is slow
  maxThrottledRate: num('MAX_THROTTLED_RATE', 0.01),
};

export function intEnv(name, fallback) {
  return num(name, fallback);
}

export function strEnv(name, fallback) {
  const raw = __ENV[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Parse the seed file content (the script calls open(__ENV.TOKENS_FILE) itself: k6 resolves
 * open() paths relative to the calling script). */
export function parseSeed(text) {
  let seed;
  try {
    seed = JSON.parse(text);
  } catch (e) {
    fail(`TOKENS_FILE is not valid JSON: ${e}`);
  }
  return seed;
}

export function requireTokensFile() {
  return required('TOKENS_FILE');
}
