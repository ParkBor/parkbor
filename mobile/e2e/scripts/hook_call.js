/* eslint-disable no-var, no-undef -- Maestro (GraalJS) script: globals output/http/json/maestro and env vars are injected */
// Calls the test-only hook server (helpers/e2e_hook_server.py).
// Inputs (runScript env): HOOK_PATH (e.g. /login-code), HOOK_BODY (JSON string).
// Globals from `maestro test -e`: E2E_HOOK_KEY (required), E2E_HOOK_URL (default http://127.0.0.1:8765).
// Output: output.hook = parsed JSON answer. Any non-2xx answer fails the flow.
var base = typeof E2E_HOOK_URL === 'undefined' ? 'http://127.0.0.1:8765' : E2E_HOOK_URL;
if (typeof E2E_HOOK_KEY === 'undefined') {
  throw new Error('E2E_HOOK_KEY is not set: pass -e E2E_HOOK_KEY=... (see mobile/e2e/README.md)');
}
var response = http.post(base + HOOK_PATH, {
  headers: { 'X-E2E-Key': E2E_HOOK_KEY, 'Content-Type': 'application/json' },
  body: HOOK_BODY,
});
var parsed = json(response.body);
if (!response.ok) {
  throw new Error('hook ' + HOOK_PATH + ' answered ' + response.status + ': ' + (parsed && parsed.error));
}
output.hook = parsed;
