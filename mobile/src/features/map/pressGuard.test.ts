import { describe, expect, it } from 'vitest';

import { PRESS_SUPPRESS_MS, createPressGuard } from '@/features/map/pressGuard';

describe('createPressGuard', () => {
  it('handles a map tap when no marker was tapped', () => {
    expect(createPressGuard(() => 1000).shouldHandleMapPress()).toBe(true);
  });

  it('ignores the map tap that follows a marker tap within the window', () => {
    let t = 1000;
    const guard = createPressGuard(() => t);
    guard.markTapped();
    t += PRESS_SUPPRESS_MS - 1;
    expect(guard.shouldHandleMapPress()).toBe(false);
  });

  it('handles map taps again once the window has passed', () => {
    let t = 1000;
    const guard = createPressGuard(() => t);
    guard.markTapped();
    t += PRESS_SUPPRESS_MS;
    expect(guard.shouldHandleMapPress()).toBe(true);
  });

  it('a new marker tap restarts the window', () => {
    let t = 0;
    const guard = createPressGuard(() => t);
    guard.markTapped();
    t = 300;
    guard.markTapped();
    t = 600;
    expect(guard.shouldHandleMapPress()).toBe(false);
  });

  it('survives a clock that moves backwards', () => {
    let t = 5000;
    const guard = createPressGuard(() => t);
    guard.markTapped();
    t = 100;
    expect(guard.shouldHandleMapPress()).toBe(true);
  });
});
