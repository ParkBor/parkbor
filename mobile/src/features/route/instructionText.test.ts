import { describe, expect, it } from 'vitest';

import {
  compassText,
  describeInstruction,
  sanitizeStreetName,
  type StepForText,
} from '@/features/route/instructionText';
import { INSTRUCTION_KEYS } from '@/features/route/routeSchemas';
import type { Language } from '@/lib/types';

const LANGS: Language[] = ['uz', 'ru', 'en'];
const stepOf = (key: StepForText['key'], over: Partial<StepForText> = {}): StepForText => ({
  key,
  name: '',
  roundaboutExit: null,
  ...over,
});

describe('describeInstruction', () => {
  it.each(INSTRUCTION_KEYS.flatMap((key) => LANGS.map((lang) => [key, lang] as const)))(
    'has non-empty text for %s in %s',
    (key, lang) => {
      const { text } = describeInstruction(stepOf(key), lang);
      expect(text.trim().length).toBeGreaterThan(2);
      expect(text).not.toMatch(/[{}]/);
    },
  );

  it('texts differ between languages (no accidental copy)', () => {
    for (const key of INSTRUCTION_KEYS) {
      const texts = LANGS.map((lang) => describeInstruction(stepOf(key), lang).text);
      expect(new Set(texts).size, key).toBe(3);
    }
  });

  it('falls back to the "other" text for an unknown key', () => {
    const unknown = describeInstruction(stepOf('teleport' as StepForText['key']), 'en');
    expect(unknown).toEqual(describeInstruction(stepOf('other'), 'en'));
  });

  it('puts the street name next to the instruction, separately', () => {
    expect(describeInstruction(stepOf('turn_left', { name: 'Navoi' }), 'en')).toEqual({
      text: 'Turn left',
      street: 'Navoi',
    });
    expect(describeInstruction(stepOf('turn_left'), 'en').street).toBeNull();
  });

  it('adds the exit number for a roundabout, in every language', () => {
    for (const lang of LANGS) {
      const withExit = describeInstruction(stepOf('roundabout', { roundaboutExit: 2 }), lang).text;
      const plain = describeInstruction(stepOf('roundabout'), lang).text;
      expect(withExit).toContain('2');
      expect(withExit).not.toBe(plain);
      expect(plain).not.toMatch(/\d/);
    }
  });

  it('ignores an exit on non-roundabout steps', () => {
    expect(describeInstruction(stepOf('turn_left', { roundaboutExit: 2 }), 'en').text).toBe('Turn left');
  });

  it('sanitizes the street name it returns', () => {
    const { street } = describeInstruction(stepOf('straight', { name: 'A\u0000B‮c' }), 'en');
    expect(street).toBe('ABc');
  });

  it('returns null street when the name is only junk', () => {
    expect(describeInstruction(stepOf('straight', { name: '\u0000​  ' }), 'en').street).toBeNull();
  });
});

describe('sanitizeStreetName', () => {
  it('removes control, zero-width and bidi override characters', () => {
    expect(sanitizeStreetName('Ab\u0007c\u0085d\u007fe​f⁦g﻿h')).toBe('Abcdefgh');
  });

  it('removes every format/control category like the backend (soft hyphen, ALM, Mongolian VS, tags)', () => {
    const junk = '­؜᠎￹￺￻\u{E0001}\u{E0041}\u{E007F}';
    expect(sanitizeStreetName(`A${junk}B`)).toBe('AB');
  });

  it('turns tabs/newlines into spaces and line separators too', () => {
    expect(sanitizeStreetName('A\tB\nC D')).toBe('A B C D');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeStreetName('  Amir \n\t  Temur  ')).toBe('Amir Temur');
  });

  it('truncates long names on code points with an ellipsis', () => {
    const long = '\u{1F697}'.repeat(200);
    const out = sanitizeStreetName(long);
    expect([...out].length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('keeps markup as inert text and keeps unicode', () => {
    expect(sanitizeStreetName('<b>Alisher</b> & Navoiy ko‘chasi')).toBe('<b>Alisher</b> & Navoiy ko‘chasi');
    expect(sanitizeStreetName('Улица Ленина')).toBe('Улица Ленина');
  });

  it('handles non-string input safely', () => {
    expect(sanitizeStreetName(undefined as unknown as string)).toBe('');
    expect(sanitizeStreetName(null as unknown as string)).toBe('');
  });
});

describe('compassText', () => {
  it('names every direction in every language', () => {
    for (const lang of LANGS) {
      for (const c of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const) {
        expect(compassText(c, lang).length).toBeGreaterThan(0);
      }
    }
    expect(compassText('ne', 'en')).toBe('northeast');
  });
});
