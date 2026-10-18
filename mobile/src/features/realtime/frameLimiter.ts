export const MAX_FRAMES_PER_SECOND = 50;

export interface FrameLimiter {
  /** False when this frame exceeds the budget of the current second (drop it unparsed). */
  allow: () => boolean;
}

/** A hostile or buggy server cannot make the app parse and apply frames without bound. */
export function createFrameLimiter(now: () => number, perSecond: number = MAX_FRAMES_PER_SECOND): FrameLimiter {
  let windowStart = now();
  let count = 0;
  return {
    allow() {
      const t = now();
      if (t - windowStart >= 1000 || t < windowStart) {
        windowStart = t;
        count = 0;
      }
      count += 1;
      return count <= perSecond;
    },
  };
}
