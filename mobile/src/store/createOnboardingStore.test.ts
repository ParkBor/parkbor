import { createStore } from 'zustand/vanilla';
import { describe, expect, it } from 'vitest';

import type { AuthStatus } from '@/store/createAuthStore';
import { createOnboardingStore } from '@/store/createOnboardingStore';

function fakeAuth(initial: AuthStatus = 'loading') {
  const auth = createStore<{ status: AuthStatus }>()(() => ({ status: initial }));
  return { auth, setStatus: (status: AuthStatus) => auth.setState({ status }) };
}

describe('onboarding store', () => {
  it('starts without a pending step and stores steps', () => {
    const { auth } = fakeAuth();
    const store = createOnboardingStore(auth);
    expect(store.getState().step).toBeNull();
    store.getState().setStep('profile');
    expect(store.getState().step).toBe('profile');
  });

  it('resets the pending step whenever the session becomes anonymous (logout / expiry)', () => {
    const { auth, setStatus } = fakeAuth('authenticated');
    const store = createOnboardingStore(auth);
    store.getState().setStep('permissions');
    setStatus('anonymous');
    expect(store.getState().step).toBeNull();
  });

  it('keeps the step while authenticated or loading', () => {
    const { auth, setStatus } = fakeAuth('anonymous');
    const store = createOnboardingStore(auth);
    store.getState().setStep('profile');
    setStatus('authenticated');
    expect(store.getState().step).toBe('profile');
    setStatus('loading');
    expect(store.getState().step).toBe('profile');
  });
});
