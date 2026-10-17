import { describe, expect, it } from 'vitest';

import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';
import uz from '@/i18n/uz.json';
import { plateProblemKey } from '@/features/operator/plateText';

function has(catalog: unknown, key: string): boolean {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
  return typeof value === 'string' && value.length > 0;
}

describe('plateProblemKey', () => {
  it.each(['empty', 'length', 'charset', 'mix', 'ascii'] as const)('%s maps to an existing message in every language', (problem) => {
    const key = plateProblemKey(problem);
    for (const catalog of [uz, ru, en]) expect(has(catalog, key), key).toBe(true);
  });
});
