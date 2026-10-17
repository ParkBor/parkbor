import { describe, expect, it } from 'vitest';

import { loadLanguage, saveLanguage, type LanguageSlot } from '@/i18n/languagePreference';

function slot(initial: string | null): LanguageSlot & { value: string | null } {
  const s = {
    value: initial,
    get: async () => s.value,
    set: async (v: string) => {
      s.value = v;
    },
  };
  return s;
}

describe('language preference', () => {
  it('round-trips a supported language', async () => {
    const s = slot(null);
    await saveLanguage(s, 'ru');
    expect(await loadLanguage(s)).toBe('ru');
  });

  it('ignores unknown or tampered stored values', async () => {
    expect(await loadLanguage(slot('de'))).toBeNull();
    expect(await loadLanguage(slot(''))).toBeNull();
    expect(await loadLanguage(slot(null))).toBeNull();
  });

  it('never throws when the store fails', async () => {
    const broken: LanguageSlot = {
      get: async () => {
        throw new Error('boom');
      },
      set: async () => {
        throw new Error('boom');
      },
    };
    await expect(loadLanguage(broken)).resolves.toBeNull();
    await expect(saveLanguage(broken, 'en')).resolves.toBeUndefined();
  });
});
