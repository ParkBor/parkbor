import { afterEach, describe, expect, it } from 'vitest';

import { currentPushToken } from '@/features/push/logoutToken';

afterEach(() => currentPushToken.set(null));

describe('currentPushToken', () => {
  it('is empty by default', () => {
    expect(currentPushToken.get()).toBeNull();
  });

  it('holds the token until it is replaced or cleared', () => {
    currentPushToken.set('ExponentPushToken[abc]');
    expect(currentPushToken.get()).toBe('ExponentPushToken[abc]');
    expect(currentPushToken.get()).toBe('ExponentPushToken[abc]'); // reading does not consume it
    currentPushToken.set(null);
    expect(currentPushToken.get()).toBeNull();
  });
});
