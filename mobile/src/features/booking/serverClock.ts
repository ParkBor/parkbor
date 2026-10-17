/** Offsets larger than this are not clock skew but garbage (or a hostile proxy): ignored. */
export const MAX_SKEW_MS = 24 * 3_600_000;
/** A round trip slower than this says nothing precise about the server time. */
export const MAX_RTT_MS = 10_000;
/** A sample this far from the current estimate must be confirmed by a second, agreeing sample. */
export const JUMP_MS = 2 * 60_000;
const CONFIRM_TOLERANCE_MS = 5_000;
/** The Date header is truncated to whole seconds: on average half a second is missing. */
const HEADER_TRUNCATION_MS = 500;

export interface ClockSample {
  /** HTTP `Date` response header. */
  dateHeader: string | undefined;
  /** HTTP `Age` response header: present = the answer came from a cache, its Date is old. */
  ageHeader?: string | undefined;
  /** Device clock when the request was sent / the response arrived. */
  sentAtMs: number;
  receivedAtMs: number;
}

export interface ServerClock {
  /** Best estimate of the server's current time. */
  now(): number;
  observe(sample: ClockSample): void;
  skewMs(): number;
  reset(): void;
}

interface Estimate {
  skewMs: number;
  rttMs: number;
}

/**
 * Holds and hold-expiry times come from the server, but a countdown needs "now". The device clock
 * may be minutes off, which would show a wrong hold timer. Each response carries a `Date` header.
 *
 * Quality rules: the request midpoint is compared with the header (so latency cancels out to
 * +-rtt/2); the sample with the SMALLEST round trip wins; cached answers (`Age`), impossible or
 * slow round trips and absurd offsets are ignored; a sudden jump (> 2 min from the estimate) is
 * only accepted once a second sample agrees (a single odd proxy header cannot move the timer).
 * Accuracy is about +-1 s, enough for a 10-minute hold. The server stays authoritative: expiry is
 * always confirmed by refetching the booking.
 */
export function createServerClock(deviceNow: () => number): ServerClock {
  let best: Estimate | null = null;
  let pending: number | null = null;

  return {
    now: () => deviceNow() + (best?.skewMs ?? 0),
    skewMs: () => best?.skewMs ?? 0,
    observe(sample) {
      if (sample.dateHeader === undefined || sample.ageHeader !== undefined) return;
      const serverMs = Date.parse(sample.dateHeader);
      const rtt = sample.receivedAtMs - sample.sentAtMs;
      if (!Number.isFinite(serverMs) || !Number.isFinite(rtt) || rtt < 0 || rtt > MAX_RTT_MS) return;
      const midpoint = sample.sentAtMs + rtt / 2;
      const skewMs = serverMs + HEADER_TRUNCATION_MS - midpoint;
      if (Math.abs(skewMs) > MAX_SKEW_MS) return;

      if (best !== null && Math.abs(skewMs - best.skewMs) > JUMP_MS) {
        const confirmed = pending !== null && Math.abs(skewMs - pending) <= CONFIRM_TOLERANCE_MS;
        pending = skewMs;
        if (!confirmed) return;
        best = { skewMs, rttMs: rtt };
        pending = null;
        return;
      }
      pending = null;
      if (best === null || rtt <= best.rttMs) best = { skewMs, rttMs: rtt };
    },
    reset() {
      best = null;
      pending = null;
    },
  };
}

/** App-wide clock. */
export const serverClock: ServerClock = createServerClock(() => Date.now());
