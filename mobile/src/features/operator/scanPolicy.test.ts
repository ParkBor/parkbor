import { describe, expect, it } from 'vitest';

import { rawCheckIn, rawLot, rawLotPage } from '@/features/operator/fixtures';
import { cardFromCheckIn, cardFromFailure } from '@/features/operator/gateResult';
import { effectivePlateCheck, resolveEntryPlate } from '@/features/operator/lotPolicy';
import { parseCheckIn, parseLotPage } from '@/features/operator/operatorSchemas';

import {
  cameraAccess,
  canScanNow,
  shouldClearOnChange,
  shouldWipe,
  cardTtlMs,
  createScanGate,
  DEDUP_WINDOW_MS,
  isCameraActive,
  MAX_SCAN_LENGTH,
  validateScanText,
} from '@/features/operator/scanPolicy';

const TOKEN = 'eyJiIjoiMSJ9:1vABcd:Zm9vYmFyYmF6LV8xMjM0NTY3ODkw';

describe('validateScanText', () => {
  it('accepts a signed-token shaped text and trims the ends', () => {
    expect(validateScanText(`  ${TOKEN}\n`)).toEqual({ ok: true, token: TOKEN });
  });

  it('accepts base64url, colon, dot and padding characters only', () => {
    expect(validateScanText('abc.DEF-ghi_123:456=')).toMatchObject({ ok: true });
  });

  it.each([null, undefined, 5, {}, ''])('rejects the non-text / empty value %j', (value) => {
    expect(validateScanText(value)).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects very short junk', () => {
    expect(validateScanText('abc')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('rejects over-long text (> 1024) before any other check', () => {
    expect(validateScanText('a'.repeat(MAX_SCAN_LENGTH))).toMatchObject({ ok: true });
    expect(validateScanText('a'.repeat(MAX_SCAN_LENGTH + 1))).toEqual({ ok: false, reason: 'too_long' });
  });

  it.each([
    ['URL', 'https://example.com/pay?x=1'],
    ['inner whitespace', 'abcdefgh ijklmnop:qrstuv'],
    ['non-ASCII', 'abcdefghijklmnopЖ:qrstuv'],
    ['emoji', 'abcdefghijklmnop🙂:qrstuv'],
    ['control char', 'abcdefghijklmnop\u0000qrstuv'],
    ['SQL-ish', "abcdefghijklmnop'; DROP--"],
    ['JSON', '{"a":"bcdefghijklmnop"}'],
  ])('rejects %s', (_name, text) => {
    expect(validateScanText(text)).toEqual({ ok: false, reason: 'charset' });
  });

  it('never returns the rejected text', () => {
    expect(JSON.stringify(validateScanText('https://secret.example/x'))).not.toContain('secret');
  });
});

describe('createScanGate', () => {
  it('accepts the first scan, then blocks every scan while a request is in flight', () => {
    let now = 1000;
    const gate = createScanGate(() => now);
    expect(gate.offer('a'.repeat(20))).toBe('accept');
    expect(gate.offer('b'.repeat(20))).toBe('busy');
    gate.release();
    now += DEDUP_WINDOW_MS + 1;
    expect(gate.offer('b'.repeat(20))).toBe('accept');
  });

  it('ignores the same code within 3 s of the last scan, even after release', () => {
    let now = 0;
    const gate = createScanGate(() => now);
    const code = 'c'.repeat(20);
    expect(gate.offer(code)).toBe('accept');
    gate.release();
    now += DEDUP_WINDOW_MS - 1;
    expect(gate.offer(code)).toBe('duplicate');
    now += DEDUP_WINDOW_MS;
    expect(gate.offer(code)).toBe('accept');
  });

  it('a different code right after release is accepted', () => {
    const gate = createScanGate(() => 5);
    gate.offer('d'.repeat(20));
    gate.release();
    expect(gate.offer('e'.repeat(20))).toBe('accept');
  });

  it('sliding window: a code that stays in front of the camera keeps being ignored', () => {
    let now = 0;
    const gate = createScanGate(() => now);
    const code = 'f'.repeat(20);
    gate.offer(code);
    gate.release();
    for (const t of [2000, 4000, 6000, 8000]) {
      now = t;
      expect(gate.offer(code)).toBe('duplicate');
    }
    now = 8000 + DEDUP_WINDOW_MS + 1;
    expect(gate.offer(code)).toBe('accept');
  });

  it('reset forgets the last code and the busy flag (app went to background)', () => {
    const gate = createScanGate(() => 0);
    const code = 'g'.repeat(20);
    gate.offer(code);
    gate.reset();
    expect(gate.offer(code)).toBe('accept');
  });

  it('touch keeps the window alive while a result is on screen: a QR held in frame does not loop', () => {
    let now = 0;
    const gate = createScanGate(() => now);
    const code = 'h'.repeat(20);
    expect(gate.offer(code)).toBe('accept');
    gate.release();
    // The result card is shown for 8 s; the camera keeps seeing the code and reports it as touched.
    for (const t of [1000, 3000, 5000, 7000, 8000]) {
      now = t;
      gate.touch(code);
    }
    // Card dismissed at 8 s: the code is still in frame -> still a duplicate, no new request.
    now = 8500;
    expect(gate.offer(code)).toBe('duplicate');
    // It left the frame for more than the window: a deliberate new scan is accepted.
    now = 8500 + DEDUP_WINDOW_MS + 1;
    expect(gate.offer(code)).toBe('accept');
  });

  it('touch of another code does not extend the window of the remembered one', () => {
    let now = 0;
    const gate = createScanGate(() => now);
    gate.offer('i'.repeat(20));
    gate.release();
    now = 2000;
    gate.touch('j'.repeat(20));
    now = DEDUP_WINDOW_MS + 1;
    expect(gate.offer('i'.repeat(20))).toBe('accept');
  });

  it('a foreign QR notice is rate limited and never replaces the remembered real code', () => {
    let now = 0;
    const gate = createScanGate(() => now);
    const code = 'k'.repeat(20);
    gate.offer(code);
    gate.release();
    expect(gate.invalidNotice()).toBe(true);
    now = 1000;
    expect(gate.invalidNotice()).toBe(false);
    now = DEDUP_WINDOW_MS + 1;
    expect(gate.invalidNotice()).toBe(true);
    now = 2000;
    expect(gate.offer(code)).toBe('duplicate');
  });
});

describe('canScanNow', () => {
  const ok = { hasLot: true, mode: 'entry', canCheckIn: true, canCheckOut: true, isPlateReady: true, isBlocked: false, lockedUntilMs: null, nowMs: 1000 } as const;

  it('allows a normal scan', () => {
    expect(canScanNow(ok)).toEqual({ ok: true });
  });

  it('explains every refusal', () => {
    expect(canScanNow({ ...ok, hasLot: false })).toEqual({ ok: false, reason: 'no_lot' });
    expect(canScanNow({ ...ok, canCheckIn: false })).toEqual({ ok: false, reason: 'entry_disabled' });
    expect(canScanNow({ ...ok, mode: 'exit', canCheckOut: false })).toEqual({ ok: false, reason: 'exit_disabled' });
    expect(canScanNow({ ...ok, isPlateReady: false })).toEqual({ ok: false, reason: 'plate_missing' });
    expect(canScanNow({ ...ok, isBlocked: true })).toEqual({ ok: false, reason: 'blocked' });
  });

  it('a missing plate matters only for entry, and only blocks the SCAN (not the camera)', () => {
    expect(canScanNow({ ...ok, mode: 'exit', isPlateReady: false })).toEqual({ ok: true });
  });

  it('scan_locked pauses ENTRY until Retry-After is over; exit keeps working', () => {
    expect(canScanNow({ ...ok, lockedUntilMs: 5000 })).toEqual({ ok: false, reason: 'locked' });
    expect(canScanNow({ ...ok, lockedUntilMs: 1000 })).toEqual({ ok: true });
    expect(canScanNow({ ...ok, mode: 'exit', lockedUntilMs: 5000 })).toEqual({ ok: true });
  });
});

describe('shouldClearOnChange', () => {
  const on = { isFocused: true, appState: 'active', access: 'granted', mode: 'entry' } as const;

  it('wipes when the camera stops being useful or the mode changes', () => {
    expect(shouldClearOnChange(on, { ...on, isFocused: false })).toBe(true);
    expect(shouldClearOnChange(on, { ...on, appState: 'background' })).toBe(true);
    expect(shouldClearOnChange(on, { ...on, appState: 'inactive' })).toBe(true);
    expect(shouldClearOnChange(on, { ...on, access: 'settings' })).toBe(true);
    expect(shouldClearOnChange(on, { ...on, mode: 'exit' })).toBe(true);
  });

  it('keeps the result when nothing relevant changed', () => {
    expect(shouldClearOnChange(on, { ...on })).toBe(false);
  });

  it('coming back (inactive -> active) is not a reason to wipe again', () => {
    const away = { ...on, appState: 'background' } as const;
    expect(shouldClearOnChange(away, on)).toBe(false);
  });
});

describe('require_plate_on_checkin: emptying the plate never removes a result already on screen', () => {
  const lot = parseLotPage(rawLotPage([rawLot({ require_plate_on_checkin: true })])).results[0] ?? null;
  const cards = {
    green: cardFromCheckIn(parseCheckIn(rawCheckIn())),
    amber: cardFromCheckIn(parseCheckIn(rawCheckIn({ allowed: false, result: 'already_checked_in' }))),
    red: cardFromFailure({ reasonKey: 'operator.reason.plate_mismatch', code: 'plate_mismatch', status: 409, retry: 'none', retryAfterSec: null }),
  };
  const camera = { isFocused: true, appState: 'active', access: 'granted', mode: 'entry' } as const;

  it.each(['green', 'amber', 'red'] as const)('%s card: plate cleared after the result -> camera, wipe decision and card are unchanged', (tone) => {
    expect(cards[tone].tone).toBe(tone);
    const check = effectivePlateCheck(lot, false);
    expect(check).toEqual({ enabled: true, locked: true });
    // The plate field is emptied (this is what the screen does once the result appears):
    const plate = resolveEntryPlate(check, '');
    expect(plate.ok).toBe(false);
    // ... which touches NOTHING about the camera or the wipe decision:
    expect(isCameraActive(camera)).toBe(true);
    // (emptying the plate is not an input of the wipe decision at all)
    // ... and only gates the NEXT scan (the card is still being shown, so scanning is blocked anyway):
    const ctx = { hasLot: true, mode: 'entry', canCheckIn: true, canCheckOut: true, isPlateReady: plate.ok, lockedUntilMs: null, nowMs: 0 } as const;
    expect(canScanNow({ ...ctx, isBlocked: true })).toEqual({ ok: false, reason: 'blocked' });
    // After the card is dismissed a scan without a plate is refused with its own reason, not silently:
    expect(canScanNow({ ...ctx, isBlocked: false })).toEqual({ ok: false, reason: 'plate_missing' });
  });
});

describe('shouldWipe: a pending cash step is never wiped', () => {
  const on = { isFocused: true, appState: 'active', access: 'granted', mode: 'entry' } as const;
  const changes = {
    'screen left (blur / tab switch)': { ...on, isFocused: false },
    'app in background': { ...on, appState: 'background' },
    'iOS inactive (notification shade)': { ...on, appState: 'inactive' },
    'camera permission lost': { ...on, access: 'settings' },
    'mode switched': { ...on, mode: 'exit' },
  } as const;

  it.each(Object.entries(changes))('cash pending + %s -> keep the cash panel', (_name, next) => {
    expect(shouldWipe({ isCashPending: true }, on, next)).toBe(false);
  });

  it.each(Object.entries(changes))('no cash pending + %s -> wipe (same as shouldClearOnChange)', (_name, next) => {
    expect(shouldWipe({ isCashPending: false }, on, next)).toBe(true);
    expect(shouldClearOnChange(on, next)).toBe(true);
  });

  it('nothing changed -> never wipes; coming back is not a wipe either', () => {
    expect(shouldWipe({ isCashPending: false }, on, { ...on })).toBe(false);
    expect(shouldWipe({ isCashPending: false }, { ...on, appState: 'background' }, on)).toBe(false);
    expect(shouldWipe({ isCashPending: true }, { ...on, appState: 'background' }, on)).toBe(false);
  });
});

describe('cardTtlMs', () => {
  it('green disappears fastest, amber / red stay longer', () => {
    expect(cardTtlMs('green', false)).toBe(5000);
    expect(cardTtlMs('amber', false)).toBe(8000);
    expect(cardTtlMs('red', false)).toBe(8000);
  });

  it('never auto-dismisses a card that waits for an operator action (cash, retry)', () => {
    for (const tone of ['green', 'amber', 'red'] as const) expect(cardTtlMs(tone, true)).toBeNull();
  });
});

describe('cameraAccess', () => {
  it('maps the permission object to a screen state', () => {
    expect(cameraAccess(null)).toBe('loading');
    expect(cameraAccess({ granted: true, canAskAgain: true, status: 'granted' })).toBe('granted');
    expect(cameraAccess({ granted: false, canAskAgain: true, status: 'undetermined' })).toBe('ask');
    expect(cameraAccess({ granted: false, canAskAgain: true, status: 'denied' })).toBe('ask');
    expect(cameraAccess({ granted: false, canAskAgain: false, status: 'denied' })).toBe('settings');
  });
});

describe('isCameraActive', () => {
  it('runs only when focused, app in foreground and permission granted', () => {
    expect(isCameraActive({ isFocused: true, appState: 'active', access: 'granted' })).toBe(true);
    expect(isCameraActive({ isFocused: false, appState: 'active', access: 'granted' })).toBe(false);
    expect(isCameraActive({ isFocused: true, appState: 'background', access: 'granted' })).toBe(false);
    expect(isCameraActive({ isFocused: true, appState: 'inactive', access: 'granted' })).toBe(false);
    expect(isCameraActive({ isFocused: true, appState: 'active', access: 'ask' })).toBe(false);
  });
});
