import type { Tone } from '@/features/operator/gateResult';

// Scanner rules. The scanned text is a django-signing token. Its CONTENT is never parsed here:
// the app only checks length and a character allowlist, then hands it to the server, which is the
// only authority (signature, expiry, lot, purpose, one-time nonce).

/** The server signs tokens of at most 1024 characters (ARCHITECTURE 10.8). */
export const MAX_SCAN_LENGTH = 1024;
const MIN_SCAN_LENGTH = 16;
/** base64url + `:` separators + `.` (compressed marker) + `=` padding. ASCII only, no whitespace. */
const TOKEN_CHARSET = /^[A-Za-z0-9\-_:.=]+$/;

/** The same code scanned again within this window is ignored (a camera sees one QR many times). */
export const DEDUP_WINDOW_MS = 3000;

export type ScanProblem = 'empty' | 'too_short' | 'too_long' | 'charset';
export type ScanCheck = { ok: true; token: string } | { ok: false; reason: ScanProblem };

/** Never echoes the scanned text in the result (a rejected scan may be somebody else's data). */
export function validateScanText(raw: unknown): ScanCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  if (raw.length > MAX_SCAN_LENGTH + 64) return { ok: false, reason: 'too_long' };
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.length > MAX_SCAN_LENGTH) return { ok: false, reason: 'too_long' };
  if (!TOKEN_CHARSET.test(text)) return { ok: false, reason: 'charset' };
  if (text.length < MIN_SCAN_LENGTH) return { ok: false, reason: 'too_short' };
  return { ok: true, token: text };
}

export type ScanOffer = 'accept' | 'duplicate' | 'busy';

export interface ScanGate {
  /** Decide about a freshly scanned token. `accept` marks the gate busy until `release()`. */
  offer(token: string): ScanOffer;
  /**
   * The camera saw this token while scanning is paused (result card on screen). Keeps the
   * "still in frame" window alive, so dismissing the card does not re-send a QR that is still held
   * in front of the camera.
   */
  touch(token: string): void;
  /** True at most once per window: show "this is not a ParkBor QR" without touching the remembered code. */
  invalidNotice(): boolean;
  /** The request (and its result handling) is over; scanning may continue. */
  release(): void;
  /** Forget everything (app went to background, screen left). */
  reset(): void;
}

export function createScanGate(now: () => number = Date.now, dedupMs: number = DEDUP_WINDOW_MS): ScanGate {
  let busy = false;
  let lastToken: string | null = null;
  let lastAtMs = 0;
  let invalidAtMs: number | null = null;

  const isSameInWindow = (token: string, at: number): boolean =>
    lastToken === token && at - lastAtMs < dedupMs && at >= lastAtMs;

  return {
    offer(token) {
      const at = now();
      if (isSameInWindow(token, at)) {
        // Sliding window: a QR that stays in the frame keeps being ignored; it counts again only
        // after it was out of sight for the whole window (no request loop on a held phone).
        lastAtMs = at;
        return 'duplicate';
      }
      if (busy) return 'busy';
      busy = true;
      lastToken = token;
      lastAtMs = at;
      return 'accept';
    },
    touch(token) {
      const at = now();
      if (isSameInWindow(token, at)) lastAtMs = at;
    },
    invalidNotice() {
      const at = now();
      if (invalidAtMs !== null && at >= invalidAtMs && at - invalidAtMs < dedupMs) return false;
      invalidAtMs = at;
      return true;
    },
    release() {
      busy = false;
    },
    reset() {
      busy = false;
      lastToken = null;
      lastAtMs = 0;
      invalidAtMs = null;
    },
  };
}

const CARD_TTL_MS: Record<Tone, number> = { green: 5000, amber: 8000, red: 8000 };

/** How long a result card stays. `null` = until dismissed (cash is pending, or an action is needed). */
export function cardTtlMs(tone: Tone, needsAction: boolean): number | null {
  return needsAction ? null : CARD_TTL_MS[tone];
}

export interface CameraPermissionLike {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
}

export type CameraAccess = 'loading' | 'granted' | 'ask' | 'settings';

/** `settings`: the OS will not ask again - the only way forward is the system settings. */
export function cameraAccess(permission: CameraPermissionLike | null): CameraAccess {
  if (permission === null) return 'loading';
  if (permission.granted) return 'granted';
  return permission.canAskAgain ? 'ask' : 'settings';
}

/** The camera runs only while it is useful: screen focused, app in the foreground, permission given. */
export function isCameraActive(input: { isFocused: boolean; appState: string; access: CameraAccess }): boolean {
  return input.isFocused && input.appState === 'active' && input.access === 'granted';
}

export interface CameraState {
  isFocused: boolean;
  appState: string;
  access: CameraAccess;
  mode: 'entry' | 'exit';
}

/**
 * Wipe the result / tokens when the camera stops being useful (screen left, app backgrounded,
 * permission lost) or the mode changes. Coming BACK is not a reason; and neither is anything about
 * the typed plate: that only gates the next scan (see canScanNow).
 */
export function shouldClearOnChange(prev: CameraState, next: CameraState): boolean {
  if (prev.mode !== next.mode) return true;
  return isCameraActive(prev) && !isCameraActive(next);
}

/**
 * Whether the screen body is rebuilt after a change. A pending cash step is NEVER wiped: the slot
 * is already free and the debt is on the server, so the cash panel must still be there when the
 * operator comes back (background, tab switch, iOS "inactive"). Only the camera stops (it is
 * derived from focus / app state, not from the body being alive).
 */
export function shouldWipe(ctx: { isCashPending: boolean }, prev: CameraState, next: CameraState): boolean {
  if (ctx.isCashPending) return false;
  return shouldClearOnChange(prev, next);
}

export type ScanRefusal = 'no_lot' | 'entry_disabled' | 'exit_disabled' | 'plate_missing' | 'blocked' | 'locked';

export interface ScanContext {
  hasLot: boolean;
  mode: 'entry' | 'exit';
  canCheckIn: boolean;
  canCheckOut: boolean;
  /** Entry with the plate check on: the typed plate is complete and valid. Irrelevant for exit. */
  isPlateReady: boolean;
  /** A request runs or a result / cash step is on screen. */
  isBlocked: boolean;
  /** `scan_locked`: entry is paused until this instant (ms), or null. */
  lockedUntilMs: number | null;
  nowMs: number;
}

/**
 * May a fresh scan be turned into a request right now? Pure; the camera itself keeps running (a
 * missing plate must never tear down the camera or a result already on screen).
 */
export function canScanNow(c: ScanContext): { ok: true } | { ok: false; reason: ScanRefusal } {
  if (!c.hasLot) return { ok: false, reason: 'no_lot' };
  if (c.isBlocked) return { ok: false, reason: 'blocked' };
  if (c.mode === 'exit') return c.canCheckOut ? { ok: true } : { ok: false, reason: 'exit_disabled' };
  if (!c.canCheckIn) return { ok: false, reason: 'entry_disabled' };
  if (c.lockedUntilMs !== null && c.nowMs < c.lockedUntilMs) return { ok: false, reason: 'locked' };
  if (!c.isPlateReady) return { ok: false, reason: 'plate_missing' };
  return { ok: true };
}
