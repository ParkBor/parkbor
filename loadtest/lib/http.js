import http from 'k6/http';
import { API } from './config.js';

export function authHeaders(token, extra) {
  return Object.assign(
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    extra || {},
  );
}

/** Statuses a healthy server may answer with; everything else (5xx, 401, 400...) is a failure.
 * Pass the business statuses the scenario EXPECTS (e.g. 201/200/409) so k6's built-in
 * http_req_failed does not count them. */
export function expect(...statuses) {
  return http.expectedStatuses(...statuses);
}

export function post(path, body, token, params) {
  const p = Object.assign({}, params || {});
  p.headers = authHeaders(token, p.headers);
  return http.post(`${API}${path}`, JSON.stringify(body), p);
}

export function get(path, token, params) {
  const p = Object.assign({}, params || {});
  p.headers = authHeaders(token, p.headers);
  return http.get(`${API}${path}`, p);
}

export function jsonOf(res) {
  try {
    return res.json();
  } catch (_e) {
    return null;
  }
}

export function codeOf(res) {
  const body = jsonOf(res);
  return body && body.code ? String(body.code) : '';
}

/** Round to the whole minute (the API stores whole-minute periods). */
export function isoMinutes(offsetMinutes) {
  const ms = Math.floor((Date.now() + offsetMinutes * 60000) / 60000) * 60000;
  return new Date(ms).toISOString();
}

export function pick(list, index) {
  return list[index % list.length];
}

export function requireEnoughUsers(have, need, what) {
  if (have < need) {
    throw new Error(
      `${what}: ${have} user token(s) in the seed file but ${need} needed. ` +
        'Per-user throttles (docs/PERFORMANCE.md) would turn the run into a 429 test. ' +
        'Seed more users.',
    );
  }
}
