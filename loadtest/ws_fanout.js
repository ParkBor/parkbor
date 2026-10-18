// WebSocket subscribe fan-out with the ticket flow (ARCHITECTURE 12, 12.0).
//
// Per VU and iteration:
//   POST /ws/ticket (JWT)  ->  ws /ws/availability/?ticket=...  ->  expect {"type":"ready"}
//   -> subscribe to the lots in seed.ws.lot_ids  ->  expect "subscribed" + a snapshot "availability"
//   -> stay connected HOLD_SECONDS answering server pings, counting pushed "availability" events.
// Every TICKET_REPLAY_EVERY-th VU also reuses its (consumed) ticket and expects NO "ready"
// (close 4401).
//
// Optional second scenario `churn` (CHURN_USERS > 0): a few drivers create + cancel bookings on
// the first lot, which makes the server publish availability changes to all subscribers; the
// lag between the event `ts` and arrival is recorded (needs NTP-synced clocks, see README).
//
// Limits to respect: 5 connections per user (extras are closed with 4409) and 30 tickets/min per
// user, so VUS <= users * 5.
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { API, WS_URL, SLO, intEnv, parseSeed, requireTokensFile } from './lib/config.js';
import { authHeaders, isoMinutes, jsonOf, requireEnoughUsers } from './lib/http.js';

const seed = parseSeed(open(requireTokensFile()));
const drivers = new SharedArray('drivers', () => seed.drivers);
const lotIds = (seed.ws && seed.ws.lot_ids) || [];

const VUS = intEnv('VUS', 200);
const HOLD_SECONDS = intEnv('HOLD_SECONDS', 60);
const RAMP = __ENV.RAMP || '30s';
const MAX_PER_USER = intEnv('WS_MAX_CONNECTIONS_PER_USER', 5);
const TICKET_REPLAY_EVERY = intEnv('TICKET_REPLAY_EVERY', 10); // 0 disables
const CHURN_USERS = intEnv('CHURN_USERS', 0);
const CHURN_PER_MIN = Math.min(intEnv('CHURN_PER_MIN', 6), 8); // booking_create is 10/min/user

const ticketMs = new Trend('ws_ticket_ms', true);
const readyMs = new Trend('ws_ready_ms', true); // connect -> "ready"
const snapshotMs = new Trend('ws_snapshot_ms', true); // subscribe -> first availability
const eventLagMs = new Trend('ws_event_lag_ms', true);
const events = new Counter('ws_availability_events');
const connectFailures = new Rate('ws_connect_failures');
const unexpectedClose = new Counter('ws_unexpected_close'); // 4400/4429/1011/other during hold
const replayAccepted = new Counter('ws_ticket_replay_accepted'); // must stay 0

const okTicket = http.expectedStatuses(200, 429);

export const options = {
  scenarios: Object.assign(
    {
      subscribers: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { target: VUS, duration: RAMP },
          { target: VUS, duration: __ENV.HOLD || '3m' },
          { target: 0, duration: '15s' },
        ],
        gracefulRampDown: `${HOLD_SECONDS + 15}s`,
        exec: 'subscriber',
      },
    },
    CHURN_USERS > 0
      ? {
          churn: {
            executor: 'constant-vus',
            vus: CHURN_USERS,
            duration: __ENV.CHURN_DURATION || '3m',
            startTime: RAMP,
            exec: 'churn',
          },
        }
      : {},
  ),
  thresholds: {
    ws_ticket_ms: [`p(95)<${SLO.ticketP95}`],
    ws_ready_ms: [`p(95)<${SLO.wsReadyP95}`],
    ws_connect_failures: [`rate<${SLO.maxErrorRate}`],
    ws_ticket_replay_accepted: ['count==0'],
    ws_unexpected_close: ['count==0'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  if (lotIds.length === 0) throw new Error('seed.ws.lot_ids is empty: seed at least one ACTIVE lot');
  requireEnoughUsers(drivers.length * MAX_PER_USER, VUS, 'ws_fanout (5 sockets per user)');
}

function getTicket(driver) {
  const res = http.post(`${API}/ws/ticket`, null, {
    headers: authHeaders(driver.token),
    tags: { name: 'ws_ticket' },
    responseCallback: okTicket,
  });
  ticketMs.add(res.timings.duration);
  if (res.status !== 200) return null;
  const body = jsonOf(res);
  return body && body.ticket ? body.ticket : null;
}

export function subscriber() {
  const driver = drivers[(__VU - 1) % drivers.length];
  const ticket = getTicket(driver);
  if (!ticket) {
    connectFailures.add(1);
    sleep(5);
    return;
  }

  const url = `${WS_URL}/ws/availability/?ticket=${ticket}`;
  const opened = Date.now();
  let subscribedAt = 0;
  let gotReady = false;
  let closeCode = 0;

  const res = ws.connect(url, { tags: { name: 'ws_availability' } }, (socket) => {
    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_e) {
        return;
      }
      if (msg.type === 'ready') {
        gotReady = true;
        readyMs.add(Date.now() - opened);
        subscribedAt = Date.now();
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            groups: lotIds.slice(0, 50).map((id) => ({ kind: 'lot', id: id })),
          }),
        );
      } else if (msg.type === 'availability') {
        events.add(1);
        if (subscribedAt) {
          snapshotMs.add(Date.now() - subscribedAt);
          subscribedAt = 0; // only the first one is the snapshot
        } else if (msg.ts) {
          eventLagMs.add(Math.max(0, Date.now() - Date.parse(msg.ts)));
        }
      } else if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });
    socket.on('close', (code) => {
      closeCode = code || 0;
    });
    socket.setTimeout(() => socket.close(), HOLD_SECONDS * 1000);
  });

  connectFailures.add(!(res && res.status === 101 && gotReady));
  check(res, { 'ws upgrade is 101': (r) => r && r.status === 101 });
  // closing after the hold is our own doing (1000/1005/0); anything 4xxx or 1011 is the server's
  if (gotReady && closeCode >= 4000 && closeCode !== 4410) unexpectedClose.add(1);
  if (gotReady && closeCode === 1011) unexpectedClose.add(1);

  // ticket replay: the consumed ticket must not open a session again
  if (TICKET_REPLAY_EVERY > 0 && __VU % TICKET_REPLAY_EVERY === 0) {
    let readyAgain = false;
    let replayClose = 0;
    ws.connect(url, { tags: { name: 'ws_ticket_replay' } }, (socket) => {
      socket.on('message', (raw) => {
        if (String(raw).indexOf('"ready"') !== -1) readyAgain = true;
      });
      socket.on('close', (code) => {
        replayClose = code || 0;
      });
      socket.setTimeout(() => socket.close(), 3000);
    });
    if (readyAgain) replayAccepted.add(1);
    check(replayClose, { 'replayed ticket is closed with 4401': (c) => c === 4401 });
  }
}

export function churn() {
  const driver = drivers[(__VU - 1) % drivers.length];
  const start = 180 + (__ITER % 20) * 150; // spread windows so the vehicle never overlaps itself
  const headers = authHeaders(driver.token, {
    'Idempotency-Key': `lt-churn-${__VU}-${__ITER}-${Date.now()}`,
  });
  const res = http.post(
    `${API}/bookings`,
    JSON.stringify({
      parking_lot_id: lotIds[0],
      slot_type: (seed.ws && seed.ws.slot_type) || 'STANDARD',
      vehicle_id: driver.vehicle_id,
      start: isoMinutes(start),
      end: isoMinutes(start + 60),
    }),
    {
      headers: headers,
      tags: { name: 'churn_create' },
      responseCallback: http.expectedStatuses(201, 409, 429),
    },
  );
  if (res.status === 201) {
    const id = jsonOf(res).id;
    http.post(`${API}/bookings/${id}/cancel`, null, {
      headers: authHeaders(driver.token),
      tags: { name: 'churn_cancel' },
    });
  }
  sleep(60 / CHURN_PER_MIN);
}
