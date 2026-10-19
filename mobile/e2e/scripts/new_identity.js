/* eslint-disable no-var, no-undef -- Maestro (GraalJS) script: globals output/http/json/maestro and env vars are injected */
// A brand-new Telegram identity + a unique, VALID plate for one run.
// Telegram ids 9_300_000_000+ are reserved for E2E (loadtest seed uses 9_000_..9_2xx_...).
// Plate layout 01 A 123 BC (letter-first, passes the client and server plate rules).
var letters = 'ACEHKMOPTXY';
function pick() {
  return letters.charAt(Math.floor(Math.random() * letters.length));
}
var digits = String(100 + Math.floor(Math.random() * 900));
output.tgId = 9300000000 + Math.floor(Math.random() * 90000000);
output.plate = '01A' + digits + pick() + pick();
output.plateSpaced = output.plate.substring(0, 2) + ' ' + output.plate.charAt(2) + ' ' + digits + ' ' + output.plate.substring(6);
