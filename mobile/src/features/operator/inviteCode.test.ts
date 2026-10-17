import { describe, expect, it } from 'vitest';

import {
  formatInviteCode,
  INVITE_CODE_LENGTH,
  normalizeInviteCode,
  validateInviteCode,
} from '@/features/operator/inviteCode';

const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SHOWN = 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z';

describe('normalizeInviteCode', () => {
  it('upper-cases and drops spaces, tabs, newlines and dashes of every kind', () => {
    expect(normalizeInviteCode(' abcde-fghij\tklmno\n–pqrst—uvwxy‑z ')).toBe(CODE);
    expect(normalizeInviteCode(SHOWN)).toBe(CODE);
  });

  it('is safe on non-string input', () => {
    expect(normalizeInviteCode(undefined)).toBe('');
    expect(normalizeInviteCode(null)).toBe('');
    expect(normalizeInviteCode(42)).toBe('');
  });
});

describe('formatInviteCode', () => {
  it('groups by five while typing and stops at 26 characters', () => {
    expect(formatInviteCode('abcdefg')).toBe('ABCDE-FG');
    expect(formatInviteCode('abcde')).toBe('ABCDE');
    expect(formatInviteCode(CODE)).toBe(SHOWN);
    expect(formatInviteCode(`${CODE}EXTRA`)).toBe(SHOWN);
    expect(formatInviteCode('')).toBe('');
  });

  it('re-formatting a formatted value is stable (no dash creep)', () => {
    expect(formatInviteCode(formatInviteCode('abcdefghij'))).toBe('ABCDE-FGHIJ');
  });
});

describe('validateInviteCode', () => {
  it('accepts a full code in any common typing', () => {
    expect(validateInviteCode(SHOWN)).toEqual({ ok: true, code: CODE });
    expect(validateInviteCode(CODE.toLowerCase())).toEqual({ ok: true, code: CODE });
  });

  it('uses the RFC 4648 base32 alphabet: I, L, O, U are valid letters, digits are 2-7', () => {
    expect(validateInviteCode('ILOU'.padEnd(INVITE_CODE_LENGTH, '2'))).toMatchObject({ ok: true });
    expect(validateInviteCode('234567'.padEnd(INVITE_CODE_LENGTH, 'A'))).toMatchObject({ ok: true });
  });

  it.each(['0', '1', '8', '9'])('rejects the digit %s (not in the alphabet)', (digit) => {
    expect(validateInviteCode(`${digit}${CODE.slice(1)}`)).toEqual({ ok: false, reason: 'charset' });
  });

  it('rejects symbols, non-ASCII letters and emoji', () => {
    expect(validateInviteCode(`!${CODE.slice(1)}`)).toEqual({ ok: false, reason: 'charset' });
    expect(validateInviteCode(`Ж${CODE.slice(1)}`)).toEqual({ ok: false, reason: 'charset' });
    expect(validateInviteCode(`🙂${CODE.slice(2)}`)).toEqual({ ok: false, reason: 'charset' });
  });

  it('reports empty and wrong length (length checked after the charset)', () => {
    expect(validateInviteCode('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateInviteCode(' - ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateInviteCode(CODE.slice(0, 25))).toEqual({ ok: false, reason: 'length' });
    expect(validateInviteCode(`${CODE}A`)).toEqual({ ok: false, reason: 'length' });
  });

  it('never echoes the code in the result', () => {
    expect(JSON.stringify(validateInviteCode('1BCDE'))).not.toContain('BCDE');
  });
});
