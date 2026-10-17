import { describe, expect, it } from 'vitest';

import {
  CODE_LENGTH,
  codeSchema,
  clipboardHoldsCode,
  extractCode,
  formatTimer,
  remainingSeconds,
  sanitizeCode,
  toCells,
} from '@/features/auth/code';

describe('sanitizeCode', () => {
  it('keeps digits only and caps at 6', () => {
    expect(sanitizeCode('12a3 4-5678')).toBe('123456');
  });

  it('handles empty and non-digit input', () => {
    expect(sanitizeCode('')).toBe('');
    expect(sanitizeCode('abc')).toBe('');
  });

  it('converts unicode digits and emojis safely', () => {
    expect(sanitizeCode('١٢٣😀45')).toBe('45');
  });
});

describe('extractCode', () => {
  it('finds a standalone 6-digit code in a bot message', () => {
    expect(extractCode('Kirish kodingiz: 482913 (5 daqiqa amal qiladi)')).toBe('482913');
  });

  it('accepts a bare code with whitespace', () => {
    expect(extractCode('  482913\n')).toBe('482913');
  });

  it('rejects text without exactly 6 consecutive digits', () => {
    expect(extractCode('12345')).toBeNull();
    expect(extractCode('1234567')).toBeNull();
    expect(extractCode('')).toBeNull();
    expect(extractCode('no digits')).toBeNull();
  });

  it('rejects ambiguous text with several different 6-digit numbers', () => {
    expect(extractCode('111111 and 222222')).toBeNull();
  });

  it('ignores very long clipboard content', () => {
    expect(extractCode('1'.repeat(10_000))).toBeNull();
  });
});

describe('toCells', () => {
  it('always returns 6 cells, padding with empty strings', () => {
    expect(toCells('12')).toEqual(['1', '2', '', '', '', '']);
    expect(toCells('')).toHaveLength(CODE_LENGTH);
  });
});

describe('codeSchema', () => {
  it('accepts exactly 6 digits', () => {
    expect(codeSchema.safeParse('123456').success).toBe(true);
  });

  it.each(['', '12345', '1234567', '12345a', ' 12345', '12 456'])('rejects %j', (value) => {
    expect(codeSchema.safeParse(value).success).toBe(false);
  });
});

describe('timer helpers', () => {
  it('computes remaining seconds, clamped to zero', () => {
    expect(remainingSeconds(10_000, 4_000)).toBe(6);
    expect(remainingSeconds(10_000, 10_000)).toBe(0);
    expect(remainingSeconds(10_000, 20_000)).toBe(0);
  });

  it('rounds partial seconds up so the timer never shows 0:00 early', () => {
    expect(remainingSeconds(10_500, 10_000)).toBe(1);
  });

  it('formats m:ss', () => {
    expect(formatTimer(300)).toBe('5:00');
    expect(formatTimer(65)).toBe('1:05');
    expect(formatTimer(9)).toBe('0:09');
    expect(formatTimer(0)).toBe('0:00');
    expect(formatTimer(-5)).toBe('0:00');
  });
});

describe('clipboardHoldsCode', () => {
  it('is true only when the clipboard carries exactly the code we used', () => {
    expect(clipboardHoldsCode('482913', '482913')).toBe(true);
    expect(clipboardHoldsCode('Kirish kodingiz: 482913', '482913')).toBe(true);
  });

  it('is false for anything else, so unrelated clipboard content is never wiped', () => {
    expect(clipboardHoldsCode('999999', '482913')).toBe(false);
    expect(clipboardHoldsCode('hello', '482913')).toBe(false);
    expect(clipboardHoldsCode('', '482913')).toBe(false);
    expect(clipboardHoldsCode('482913 and 111111', '482913')).toBe(false);
  });
});
