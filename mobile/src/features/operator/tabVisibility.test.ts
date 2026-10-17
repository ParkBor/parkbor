import { describe, expect, it } from 'vitest';

import {
  canForceSlot,
  canOverrideExit,
  isOperatorRole,
  nextUserForRole,
  operatorTabVisible,
  shouldFetchOperatorLots,
} from '@/features/operator/tabVisibility';
import type { User } from '@/lib/types';

const user: User = {
  id: 7,
  telegram_id: 1,
  telegram_username: 'x',
  phone: '',
  first_name: 'A',
  last_name: 'B',
  language: 'uz',
  role: 'DRIVER',
  tg_notifications: true,
};

describe('operatorTabVisible', () => {
  it('OPERATOR always sees the tab (even before the lots load or with none)', () => {
    expect(operatorTabVisible({ role: 'OPERATOR', lotCount: null })).toBe(true);
    expect(operatorTabVisible({ role: 'OPERATOR', lotCount: 0 })).toBe(true);
    expect(operatorTabVisible({ role: 'OPERATOR', lotCount: 3 })).toBe(true);
  });

  it('OWNER / ADMIN see it only when they have lots', () => {
    for (const role of ['OWNER', 'ADMIN']) {
      expect(operatorTabVisible({ role, lotCount: null })).toBe(false);
      expect(operatorTabVisible({ role, lotCount: 0 })).toBe(false);
      expect(operatorTabVisible({ role, lotCount: 1 })).toBe(true);
    }
  });

  it.each([['DRIVER'], ['driver'], ['operator'], ['SUPERUSER'], [''], [undefined], [null]])('role %j never sees it', (role) => {
    expect(operatorTabVisible({ role, lotCount: 5 })).toBe(false);
  });
});

describe('role helpers', () => {
  it('only staff roles call the operator API', () => {
    expect(shouldFetchOperatorLots('OPERATOR')).toBe(true);
    expect(shouldFetchOperatorLots('OWNER')).toBe(true);
    expect(shouldFetchOperatorLots('ADMIN')).toBe(true);
    expect(shouldFetchOperatorLots('DRIVER')).toBe(false);
    expect(shouldFetchOperatorLots(undefined)).toBe(false);
    expect(isOperatorRole('OPERATOR')).toBe(true);
    expect(isOperatorRole('OWNER')).toBe(false);
  });

  it('override and force are OWNER / ADMIN only', () => {
    for (const fn of [canOverrideExit, canForceSlot]) {
      expect(fn('OWNER')).toBe(true);
      expect(fn('ADMIN')).toBe(true);
      expect(fn('OPERATOR')).toBe(false);
      expect(fn('DRIVER')).toBe(false);
      expect(fn(null)).toBe(false);
    }
  });
});

describe('nextUserForRole', () => {
  it('returns the fresh user when only the role changed for the same account', () => {
    const fresh = { ...user, role: 'OPERATOR' };
    expect(nextUserForRole(user, fresh)).toEqual(fresh);
  });

  it('returns null when nothing relevant changed', () => {
    expect(nextUserForRole(user, { ...user })).toBeNull();
  });

  it('returns null for another account, a missing session or a malformed body', () => {
    expect(nextUserForRole(user, { ...user, id: 8, role: 'OPERATOR' })).toBeNull();
    expect(nextUserForRole(null, { ...user, role: 'OPERATOR' })).toBeNull();
    expect(nextUserForRole(user, { id: 7 })).toBeNull();
    expect(nextUserForRole(user, null)).toBeNull();
    expect(nextUserForRole(user, 'DRIVER')).toBeNull();
    expect(nextUserForRole(user, { ...user, role: 5 })).toBeNull();
  });

  it('refuses a role outside the known set (a stray /me body cannot invent a role)', () => {
    expect(nextUserForRole(user, { ...user, role: 'SUPERUSER' })).toBeNull();
    expect(nextUserForRole(user, { ...user, role: '' })).toBeNull();
    for (const role of ['OPERATOR', 'OWNER', 'ADMIN']) {
      expect(nextUserForRole(user, { ...user, role })).toMatchObject({ role });
    }
    expect(nextUserForRole({ ...user, role: 'OPERATOR' }, { ...user, role: 'DRIVER' })).toMatchObject({ role: 'DRIVER' });
  });

  it('compares ids as strings (7 vs "7")', () => {
    expect(nextUserForRole(user, { ...user, id: '7', role: 'OWNER' })).toMatchObject({ role: 'OWNER' });
  });
});
