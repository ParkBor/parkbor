import { describe, expect, it } from 'vitest';

import { profileSchema } from '@/features/auth/schemas';

describe('profileSchema', () => {
  it('trims and accepts a normal name', () => {
    const r = profileSchema.safeParse({ firstName: '  Ali  ' });
    expect(r.success && r.data.firstName).toBe('Ali');
  });

  it('accepts unicode names', () => {
    expect(profileSchema.safeParse({ firstName: 'Ўктам' }).success).toBe(true);
    expect(profileSchema.safeParse({ firstName: "G'ayrat" }).success).toBe(true);
  });

  it.each(['', '   ', 'A'])('rejects too short %j', (firstName) => {
    const r = profileSchema.safeParse({ firstName });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('validation.nameTooShort');
  });

  it('rejects names longer than the backend limit (150)', () => {
    const r = profileSchema.safeParse({ firstName: 'x'.repeat(151) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('validation.nameTooLong');
  });

  it('rejects digits and control characters', () => {
    expect(profileSchema.safeParse({ firstName: 'Ali123' }).success).toBe(false);
    expect(profileSchema.safeParse({ firstName: 'Ali\u0000' }).success).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(profileSchema.safeParse({ firstName: null }).success).toBe(false);
    expect(profileSchema.safeParse({}).success).toBe(false);
  });
});
