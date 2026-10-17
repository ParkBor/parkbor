import { describe, expect, it, vi } from 'vitest';

import { onSessionEnd } from '@/lib/sessionEnd';

type Snapshot = { status: string; user: { id: string } | null };

function session(initial: Snapshot) {
  let state = initial;
  const listeners = new Set<(s: Snapshot) => void>();
  return {
    getState: () => state,
    subscribe: (listener: (s: Snapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: Snapshot) {
      state = next;
      listeners.forEach((l) => l(next));
    },
  };
}

const authed = (id: string): Snapshot => ({ status: 'authenticated', user: { id } });

describe('onSessionEnd', () => {
  it('fires on logout, account switch and start-up without a session', () => {
    const s = session(authed('1'));
    const callback = vi.fn();
    onSessionEnd(s, callback);
    s.set({ status: 'anonymous', user: null });
    s.set(authed('2')); // sign-in after logout: nothing new to wipe
    s.set(authed('3')); // account switch
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('does not fire while the same user stays or while loading/offline', () => {
    const s = session({ status: 'loading', user: null });
    const callback = vi.fn();
    onSessionEnd(s, callback);
    s.set({ status: 'offline', user: null });
    s.set(authed('1'));
    s.set(authed('1'));
    expect(callback).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const s = session(authed('1'));
    const callback = vi.fn();
    onSessionEnd(s, callback)();
    s.set({ status: 'anonymous', user: null });
    expect(callback).not.toHaveBeenCalled();
  });
});
