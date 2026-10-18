// Payment webhook idempotency under replay and concurrency.
//
// Each iteration: a driver creates a booking (PENDING_PAYMENT), then this script plays the
// provider and hammers the webhook:
//   Payme: CheckPerformTransaction, CreateTransaction, then CreateTransaction + PerformTransaction
//          fired REPLAYS times in parallel, PerformTransaction once more.
//   Click: Prepare, then Complete fired REPLAYS times in parallel.
// Expected: every answer is HTTP 200 without a protocol error; replays return the SAME result
// (transaction id / perform_time / merchant_confirm_id); the booking ends CONFIRMED with
// paid_amount == amount (paid once).
//
// PROVIDER=payme|click. Secrets only via env: PAYME_KEY (Basic auth password; login PAYME_LOGIN,
// default Paycom) or CLICK_SECRET + CLICK_SERVICE_ID. Staging must use the provider SANDBOX keys.
// The webhook is IP-throttled (payment_webhook 600/min per IP) and may be IP-allowlisted: run the
// test from an allowed address.
//
// Bookings stay CONFIRMED (cancelling would start a refund), and one account may hold at most
// BOOKING_MAX_ACTIVE (5) live bookings, so ITERATIONS is capped at 4 per VU; re-seed between runs.
import http from 'k6/http';
import encoding from 'k6/encoding';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { API, SLO, intEnv, parseSeed, requireTokensFile, strEnv } from './lib/config.js';
import { codeOf, get, isoMinutes, jsonOf, post, requireEnoughUsers } from './lib/http.js';

const seed = parseSeed(open(requireTokensFile()));
const drivers = new SharedArray('drivers', () => seed.drivers);
const lot = seed.payments_lot;

const PROVIDER = strEnv('PROVIDER', 'payme');
const VUS = intEnv('VUS', 10);
const ITERATIONS = Math.min(intEnv('ITERATIONS', 3), 4);
const REPLAYS = intEnv('REPLAYS', 5);
const PAYME_LOGIN = strEnv('PAYME_LOGIN', 'Paycom');
const PAYME_KEY = __ENV.PAYME_KEY || '';
const CLICK_SECRET = __ENV.CLICK_SECRET || '';
const CLICK_SERVICE_ID = __ENV.CLICK_SERVICE_ID || '';
const WEBHOOK = `${API}/payments/${PROVIDER}/webhook`;

const confirmed = new Counter('payments_confirmed');
const protocolErrors = new Counter('payments_protocol_errors'); // non-200 or RPC error: must be 0
const divergentReplays = new Counter('payments_divergent_replays'); // replay != first answer
const notConfirmed = new Counter('payments_booking_not_confirmed');
const webhookMs = new Trend('webhook_ms', true);

export const options = {
  scenarios: {
    pay: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERATIONS,
      maxDuration: __ENV.MAX_DURATION || '10m',
    },
  },
  thresholds: {
    webhook_ms: [`p(95)<${SLO.webhookP95}`],
    payments_protocol_errors: ['count==0'],
    payments_divergent_replays: ['count==0'],
    payments_booking_not_confirmed: ['count==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  if (PROVIDER !== 'payme' && PROVIDER !== 'click') {
    throw new Error('PROVIDER must be payme or click');
  }
  if (PROVIDER === 'payme' && !PAYME_KEY) throw new Error('PAYME_KEY is required (PROVIDER=payme)');
  if (PROVIDER === 'click' && (!CLICK_SECRET || !CLICK_SERVICE_ID)) {
    throw new Error('CLICK_SECRET and CLICK_SERVICE_ID are required (PROVIDER=click)');
  }
  requireEnoughUsers(drivers.length, VUS, 'payment_webhook_replay');
  return { runId: __ENV.RUN_ID || `${Date.now()}` };
}

function createBooking(driver, data) {
  // 3 h apart per iteration: one vehicle never overlaps itself
  const startOffset = 120 + __ITER * 180;
  const res = post(
    '/bookings',
    {
      parking_lot_id: lot.lot_id,
      slot_type: lot.slot_type || 'STANDARD',
      vehicle_id: driver.vehicle_id,
      start: isoMinutes(startOffset),
      end: isoMinutes(startOffset + 120),
      payment_provider: PROVIDER,
    },
    driver.token,
    {
      headers: { 'Idempotency-Key': `lt-pay-${data.runId}-${__VU}-${__ITER}` },
      tags: { name: 'booking_create' },
    },
  );
  return res.status === 201 ? jsonOf(res) : null;
}

// --- Payme (JSON-RPC 2.0, Basic auth, amounts in tiyin) ----------------------------------------

function paymeRequest(method, params, id) {
  const auth = 'Basic ' + encoding.b64encode(`${PAYME_LOGIN}:${PAYME_KEY}`);
  return {
    method: 'POST',
    url: WEBHOOK,
    body: JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params }),
    params: {
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      tags: { name: `payme_${method}` },
    },
  };
}

function paymeSend(req) {
  return http.request(req.method, req.url, req.body, req.params);
}

function rpcResult(res) {
  webhookMs.add(res.timings.duration);
  const body = jsonOf(res);
  if (res.status !== 200 || !body || body.error || !body.result) {
    protocolErrors.add(1);
    console.error(`payme webhook ${res.status} ${String(res.body).slice(0, 300)}`);
    return null;
  }
  return body.result;
}

function same(a, b, fields) {
  return !!a && !!b && fields.every((f) => a[f] === b[f]);
}

function payWithPayme(booking) {
  const amount = Math.round(Number(booking.amount) * 100);
  const account = { order_id: booking.id };
  const tx = `lt${__VU}x${__ITER}x${Date.now()}`;
  const createParams = { id: tx, time: Date.now(), amount: amount, account: account };

  const checked = rpcResult(paymeSend(paymeRequest('CheckPerformTransaction', { amount, account }, 1)));
  check(checked, { 'CheckPerformTransaction allows': (r) => !!r && r.allow === true });

  const first = rpcResult(paymeSend(paymeRequest('CreateTransaction', createParams, 2)));
  if (!first) return;

  const reqs = [];
  for (let i = 0; i < REPLAYS; i++) {
    reqs.push(paymeRequest('CreateTransaction', createParams, 10 + i));
    reqs.push(paymeRequest('PerformTransaction', { id: tx }, 20 + i));
  }
  const answers = http.batch(reqs).map(rpcResult);
  const creates = answers.filter((_, i) => i % 2 === 0);
  const performs = answers.filter((_, i) => i % 2 === 1);

  creates.forEach((r) => {
    if (r && !same(r, first, ['transaction', 'create_time'])) divergentReplays.add(1);
  });
  // Create and Perform race: a Perform that wins before the Create replay is fine, every Perform
  // answer must be state 2 with ONE perform_time (the money moved once).
  const done = performs.filter(Boolean);
  const stamps = {};
  done.forEach((r) => {
    stamps[r.perform_time] = true;
  });
  check(done, {
    'every PerformTransaction replay answers state 2': (p) =>
      p.length === REPLAYS && p.every((r) => r.state === 2),
    'all PerformTransaction replays share one perform_time': () => Object.keys(stamps).length === 1,
  });
  if (Object.keys(stamps).length > 1) divergentReplays.add(1);

  const again = rpcResult(paymeSend(paymeRequest('PerformTransaction', { id: tx }, 99)));
  if (again && done[0] && !same(again, done[0], ['transaction', 'perform_time', 'state'])) {
    divergentReplays.add(1);
  }
}

// --- Click (form-urlencoded, md5 sign_string) --------------------------------------------------

function tashkentTime() {
  const d = new Date(Date.now() + 5 * 3600 * 1000); // Asia/Tashkent: UTC+5, no DST
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function clickForm(booking, action, trans, prepareId) {
  const amount = String(booking.amount).replace(/\.00$/, '');
  const signTime = tashkentTime();
  const form = {
    click_trans_id: trans,
    service_id: CLICK_SERVICE_ID,
    click_paydoc_id: '555',
    merchant_trans_id: booking.id,
    amount: amount,
    action: String(action),
    error: '0',
    error_note: 'Success',
    sign_time: signTime,
  };
  const parts = [trans, CLICK_SERVICE_ID, CLICK_SECRET, booking.id];
  if (action === 1) {
    form.merchant_prepare_id = String(prepareId);
    parts.push(String(prepareId));
  }
  parts.push(amount, String(action), signTime);
  form.sign_string = crypto.md5(parts.join(''), 'hex');
  return form;
}

function payWithClick(booking) {
  const trans = `${Date.now()}${__VU}${__ITER}`;
  const prep = http.post(WEBHOOK, clickForm(booking, 0, trans), { tags: { name: 'click_prepare' } });
  webhookMs.add(prep.timings.duration);
  const prepBody = jsonOf(prep);
  if (prep.status !== 200 || !prepBody || Number(prepBody.error) !== 0) {
    protocolErrors.add(1);
    console.error(`click prepare ${prep.status} ${String(prep.body).slice(0, 300)}`);
    return;
  }
  const reqs = [];
  for (let i = 0; i < REPLAYS; i++) {
    reqs.push({
      method: 'POST',
      url: WEBHOOK,
      body: clickForm(booking, 1, trans, prepBody.merchant_prepare_id),
      params: { tags: { name: 'click_complete' } },
    });
  }
  const answers = http.batch(reqs).map((res) => {
    webhookMs.add(res.timings.duration);
    return res.status === 200 ? jsonOf(res) : null;
  });
  // Protocol: a replayed Complete may answer error -4 (already paid) instead of 0; both mean
  // "paid once". Anything else, or a non-200, is a failure.
  const bad = answers.filter((a) => !a || (Number(a.error) !== 0 && Number(a.error) !== -4));
  if (bad.length) protocolErrors.add(bad.length);
  const confirmIds = {};
  answers.forEach((a) => {
    if (a && Number(a.error) === 0) confirmIds[a.merchant_confirm_id] = true;
  });
  if (Object.keys(confirmIds).length > 1) divergentReplays.add(1);
}

export default function (data) {
  const driver = drivers[(__VU - 1) % drivers.length];
  const booking = createBooking(driver, data);
  if (!booking) {
    protocolErrors.add(1);
    console.error('could not create the booking to pay');
    return;
  }
  if (PROVIDER === 'payme') payWithPayme(booking);
  else payWithClick(booking);

  const after = get(`/bookings/${booking.id}`, driver.token, { tags: { name: 'booking_get' } });
  const body = jsonOf(after) || {};
  if (body.status === 'CONFIRMED' && Number(body.paid_amount) === Number(body.amount)) {
    confirmed.add(1);
  } else {
    notConfirmed.add(1);
    console.error(`booking ${booking.id} ended ${body.status} paid ${body.paid_amount}/${body.amount} ${codeOf(after)}`);
  }
}
