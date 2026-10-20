import { describe, expect, it, vi } from 'vitest';

import { createProfileApi } from '@/features/profile/profileApi';

const USER = { id: 1, first_name: 'Ali', language: 'uz' };

function setup() {
  const patch = vi.fn().mockResolvedValue({ data: USER });
  const del = vi.fn().mockResolvedValue({ status: 204 });
  return { patch, del, api: createProfileApi({ patch, delete: del } as never) };
}

describe('profileApi', () => {
  it('updateName PATCHes /me with the trimmed first_name and returns the user', async () => {
    const { api, patch } = setup();
    await expect(api.updateName('  Ali  ')).resolves.toEqual(USER);
    expect(patch).toHaveBeenCalledExactlyOnceWith('/me', { first_name: 'Ali' });
  });

  it('updateLanguage PATCHes /me with only the language', async () => {
    const { api, patch } = setup();
    await api.updateLanguage('ru');
    expect(patch).toHaveBeenCalledExactlyOnceWith('/me', { language: 'ru' });
  });

  it('deleteAccount calls DELETE /me', async () => {
    const { api, del } = setup();
    await expect(api.deleteAccount()).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledExactlyOnceWith('/me');
  });

  it('lets a blocked deletion (409) reach the caller', async () => {
    const { api, del } = setup();
    const error = Object.assign(new Error('409'), { isAxiosError: true, response: { status: 409, data: { code: 'account_deletion_blocked' } } });
    del.mockRejectedValue(error);
    await expect(api.deleteAccount()).rejects.toBe(error);
  });

  it('propagates a failed name update', async () => {
    const { api, patch } = setup();
    patch.mockRejectedValue(new Error('network'));
    await expect(api.updateName('Ali')).rejects.toThrow('network');
  });
});
