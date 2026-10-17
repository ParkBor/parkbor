import { describe, expect, it, vi } from 'vitest';

import { isOnline, wireFocus, wireOnline } from '@/lib/queryEnv';

describe('isOnline', () => {
  it.each([
    [{ isConnected: true, isInternetReachable: true }, true],
    [{ isConnected: true, isInternetReachable: null }, true],
    [{}, true],
    [{ isConnected: false, isInternetReachable: false }, false],
    [{ isConnected: false }, false],
    [{ isConnected: true, isInternetReachable: false }, false],
  ])('%j is online=%s', (state, expected) => {
    expect(isOnline(state)).toBe(expected);
  });
});

describe('wireFocus', () => {
  it('maps app state to focus and unsubscribes on cleanup', () => {
    let listener: (state: string) => void = () => undefined;
    const remove = vi.fn();
    const setFocused = vi.fn();
    const cleanup = wireFocus((l) => {
      listener = l;
      return { remove };
    }, setFocused);
    listener('background');
    listener('active');
    listener('inactive');
    expect(setFocused.mock.calls).toEqual([[false], [true], [false]]);
    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('wireOnline', () => {
  it('forwards connectivity changes and unsubscribes on cleanup', () => {
    let listener: (state: { isConnected?: boolean | null; isInternetReachable?: boolean | null }) => void = () =>
      undefined;
    const remove = vi.fn();
    const setOnline = vi.fn();
    const cleanup = wireOnline((l) => {
      listener = l;
      return { remove };
    }, setOnline);
    listener({ isConnected: false });
    listener({ isConnected: true, isInternetReachable: true });
    expect(setOnline.mock.calls).toEqual([[false], [true]]);
    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
