// Operator invite codes (ARCHITECTURE 9.3): 128 bits = 26 RFC 4648 base32 characters (A-Z, 2-7),
// shown in groups of five: ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z.
//
// The alphabet is RFC 4648, so I, L, O and U ARE valid letters and are not "fixed" to anything;
// only 0, 1, 8, 9 can never occur. The code is never logged, stored or auto-pasted.

export const INVITE_CODE_LENGTH = 26;
const GROUP = 5;
const SEPARATORS = /[\s\-‐-―−]+/gu;
const BASE32 = /^[A-Z2-7]+$/;

export type InviteProblem = 'empty' | 'charset' | 'length';
export type InviteCheck = { ok: true; code: string } | { ok: false; reason: InviteProblem };

/** Upper case, without spaces / dashes (hyphen, en/em dash, minus sign). Does not validate. */
export function normalizeInviteCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(SEPARATORS, '').toUpperCase() : '';
}

/** Input mask: normalised, cut to 26 characters, dash after every fifth. Idempotent. */
export function formatInviteCode(raw: unknown): string {
  const code = normalizeInviteCode(raw).slice(0, INVITE_CODE_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += GROUP) groups.push(code.slice(i, i + GROUP));
  return groups.join('-');
}

/** Alphabet first, then length. The result never contains the typed text on failure. */
export function validateInviteCode(raw: unknown): InviteCheck {
  const code = normalizeInviteCode(raw);
  if (code.length === 0) return { ok: false, reason: 'empty' };
  if (!BASE32.test(code)) return { ok: false, reason: 'charset' };
  if (code.length !== INVITE_CODE_LENGTH) return { ok: false, reason: 'length' };
  return { ok: true, code };
}
