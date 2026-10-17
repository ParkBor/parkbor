import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startCardTimer } from '@/features/operator/cardLifecycle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startCardTimer (result cards go away by themselves)', () => {
  it('green disappears after 5 s, amber and red after 8 s', () => {
    for (const [tone, ms] of [['green', 5000], ['amber', 8000], ['red', 8000]] as const) {
      const onDismiss = vi.fn();
      startCardTimer({ tone, needsAction: false, isScreenReader: false, onDismiss });
      vi.advanceTimersByTime(ms - 1);
      expect(onDismiss, tone).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDismiss, tone).toHaveBeenCalledTimes(1);
    }
  });

  it('a card that waits for cash or a retry never disappears by itself', () => {
    const onDismiss = vi.fn();
    startCardTimer({ tone: 'amber', needsAction: true, isScreenReader: false, onDismiss });
    vi.advanceTimersByTime(10 * 60_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('with a screen reader on, nothing vanishes before it is read (WCAG 2.2.1)', () => {
    const onDismiss = vi.fn();
    startCardTimer({ tone: 'green', needsAction: false, isScreenReader: true, onDismiss });
    vi.advanceTimersByTime(60_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('the returned function cancels the timer (a new card replaces the old one)', () => {
    const onDismiss = vi.fn();
    const cancel = startCardTimer({ tone: 'green', needsAction: false, isScreenReader: false, onDismiss });
    cancel();
    vi.advanceTimersByTime(20_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('cancelling a timer that never started is harmless', () => {
    const cancel = startCardTimer({ tone: 'green', needsAction: true, isScreenReader: false, onDismiss: vi.fn() });
    expect(() => cancel()).not.toThrow();
  });
});
