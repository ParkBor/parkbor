import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { bindQueryClientToSession } from '@/lib/queryLifecycle';

type Status = 'loading' | 'authenticated' | 'anonymous' | 'offline';
interface FakeAuth {
  status: Status;
  user: { id: string } | null;
}

function setup(initial: FakeAuth) {
  const auth = createStore<FakeAuth>()(() => initial);
  const client = { cancelQueries: vi.fn().mockResolvedValue(undefined), clear: vi.fn() };
  const unbind = bindQueryClientToSession(client, auth);
  return { auth, client, unbind };
}

describe('bindQueryClientToSession', () => {
  it('cancels and clears everything when the session ends', () => {
    const { auth, client } = setup({ status: 'authenticated', user: { id: 'a' } });
    auth.setState({ status: 'anonymous', user: null });
    expect(client.cancelQueries).toHaveBeenCalledTimes(1);
    expect(client.clear).toHaveBeenCalledTimes(1);
  });

  it('clears when another account signs in without passing through anonymous', () => {
    const { auth, client } = setup({ status: 'authenticated', user: { id: 'a' } });
    auth.setState({ status: 'authenticated', user: { id: 'b' } });
    expect(client.clear).toHaveBeenCalledTimes(1);
  });

  it('keeps the cache for unrelated updates of the same user', () => {
    const { auth, client } = setup({ status: 'authenticated', user: { id: 'a' } });
    auth.setState({ status: 'authenticated', user: { id: 'a' } });
    expect(client.clear).not.toHaveBeenCalled();
  });

  it('does nothing while anonymous or loading (nothing to leak)', () => {
    const { auth, client } = setup({ status: 'loading', user: null });
    auth.setState({ status: 'anonymous', user: null });
    auth.setState({ status: 'authenticated', user: { id: 'a' } });
    expect(client.clear).not.toHaveBeenCalled();
  });

  it('stops listening after unbind', () => {
    const { auth, client, unbind } = setup({ status: 'authenticated', user: { id: 'a' } });
    unbind();
    auth.setState({ status: 'anonymous', user: null });
    expect(client.clear).not.toHaveBeenCalled();
  });
});
