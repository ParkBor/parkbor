import { describe, expect, it } from 'vitest';

import { APP_NAME } from '@/lib/constants';

describe('constants', () => {
  it('exposes the app name', () => {
    expect(APP_NAME).toBe('Habi');
  });
});
