import { describe, expect, it } from 'vitest';

import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';
import { resolveLanguage } from '@/i18n/resolveLanguage';
import uz from '@/i18n/uz.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : flatten(value, `${prefix}${key}.`),
  );
}

function leaves(tree: Tree): string[] {
  return Object.values(tree).flatMap((v) => (typeof v === 'string' ? [v] : leaves(v)));
}

function placeholders(text: string): string[] {
  return (text.match(/{{\s*\w+\s*}}/g) ?? []).sort();
}

describe('i18n catalogs', () => {
  const uzKeys = flatten(uz as Tree).sort();

  it('uz, ru and en have identical key sets', () => {
    expect(flatten(ru as Tree).sort()).toEqual(uzKeys);
    expect(flatten(en as Tree).sort()).toEqual(uzKeys);
  });

  it('ships the anti-phishing code warning in every language', () => {
    for (const catalog of [uz, ru, en]) {
      expect(catalog.code.phishingWarning.length).toBeGreaterThan(40);
    }
    expect(en.code.phishingWarning).toMatch(/never share/i);
  });

  it('names each language in its own language for the language picker', () => {
    for (const catalog of [uz, ru, en]) {
      expect(catalog.languages).toEqual({ uz: 'O‘zbekcha', ru: 'Русский', en: 'English' });
    }
  });

  it('has no empty translations', () => {
    for (const catalog of [uz, ru, en]) {
      expect(leaves(catalog as Tree).every((s) => s.trim().length > 0)).toBe(true);
    }
  });

  it('keeps interpolation placeholders identical across languages', () => {
    const flat = (tree: Tree, prefix = ''): [string, string][] =>
      Object.entries(tree).flatMap(([k, v]) =>
        typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : flat(v, `${prefix}${k}.`),
      );
    const uzMap = new Map(flat(uz as Tree));
    for (const catalog of [ru, en]) {
      for (const [key, value] of flat(catalog as Tree)) {
        expect(placeholders(value), key).toEqual(placeholders(uzMap.get(key) ?? ''));
      }
    }
  });
});

describe('resolveLanguage', () => {
  it.each([
    ['uz', 'uz'],
    ['uz-UZ', 'uz'],
    ['ru-RU', 'ru'],
    ['en-US', 'en'],
    ['EN', 'en'],
  ])('maps %s to %s', (input, expected) => {
    expect(resolveLanguage(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'de-DE', 'xx'])('falls back to uz for %j', (input) => {
    expect(resolveLanguage(input)).toBe('uz');
  });
});
