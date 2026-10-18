import { describe, expect, it } from 'vitest';

import { decideNotificationPrompt, parsePermission, settingsAction } from '@/features/push/permissionPolicy';

describe('parsePermission', () => {
  it('maps the expo-notifications status', () => {
    expect(parsePermission({ granted: true, canAskAgain: true, status: 'granted' })).toEqual({ state: 'granted', canAskAgain: true });
    expect(parsePermission({ granted: false, canAskAgain: true, status: 'undetermined' })).toEqual({ state: 'undetermined', canAskAgain: true });
    expect(parsePermission({ granted: false, canAskAgain: false, status: 'denied' })).toEqual({ state: 'denied', canAskAgain: false });
  });

  it('treats anything unexpected as denied and not askable', () => {
    expect(parsePermission(null)).toEqual({ state: 'denied', canAskAgain: false });
    expect(parsePermission({ status: 'weird' })).toEqual({ state: 'denied', canAskAgain: false });
  });

  it('a granted flag wins over a stale status string', () => {
    expect(parsePermission({ granted: true, canAskAgain: false, status: 'denied' }).state).toBe('granted');
  });
});

describe('settingsAction', () => {
  it('offers nothing when notifications are on', () => {
    expect(settingsAction({ state: 'granted', canAskAgain: true })).toBe('none');
  });

  it('asks when the OS still allows the dialog', () => {
    expect(settingsAction({ state: 'undetermined', canAskAgain: true })).toBe('request');
    expect(settingsAction({ state: 'denied', canAskAgain: true })).toBe('request');
  });

  it('sends the user to the OS settings after a final denial', () => {
    expect(settingsAction({ state: 'denied', canAskAgain: false })).toBe('open_settings');
    expect(settingsAction({ state: 'undetermined', canAskAgain: false })).toBe('open_settings');
  });
});

describe('decideNotificationPrompt', () => {
  const base = { permission: { state: 'undetermined' as const, canAskAgain: true }, hasAskedThisRun: false, isMoment: true };

  it('asks at a meaningful moment when the OS has not been asked yet', () => {
    expect(decideNotificationPrompt(base)).toBe('ask');
  });

  it('never asks outside such a moment (not at launch)', () => {
    expect(decideNotificationPrompt({ ...base, isMoment: false })).toBe('skip');
  });

  it('asks only once per app run', () => {
    expect(decideNotificationPrompt({ ...base, hasAskedThisRun: true })).toBe('skip');
  });

  it('does nothing when already granted', () => {
    expect(decideNotificationPrompt({ ...base, permission: { state: 'granted', canAskAgain: true } })).toBe('skip');
  });

  it('does not nag after a denial the OS will not let us repeat', () => {
    expect(decideNotificationPrompt({ ...base, permission: { state: 'denied', canAskAgain: false } })).toBe('skip');
  });

  it('may ask again when denied but the OS still allows it (Android)', () => {
    expect(decideNotificationPrompt({ ...base, permission: { state: 'denied', canAskAgain: true } })).toBe('ask');
  });
});
