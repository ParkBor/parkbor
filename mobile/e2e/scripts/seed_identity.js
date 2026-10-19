/* eslint-disable no-var, no-undef -- Maestro (GraalJS) script: globals output/http/json/maestro and env vars are injected */
// Telegram id of a SEEDED account (loadtest/seed/loadtest_seed.py).
// Inputs: SEED_ROLE = driver | operator, SEED_INDEX (default 0).
// drivers   9_100_000_000 + index   (index 0 has vehicle LT00000AB)
// operators 9_200_000_000 + index   (assigned to the gate lot)
var index = typeof SEED_INDEX === 'undefined' ? 0 : parseInt(SEED_INDEX, 10);
output.tgId = (SEED_ROLE === 'operator' ? 9200000000 : 9100000000) + index;
