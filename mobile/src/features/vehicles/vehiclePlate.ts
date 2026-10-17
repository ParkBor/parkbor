// Mirror of backend/apps/vehicles/plate.py: the server stays authoritative, this gives instant feedback.
const MIN_LENGTH = 5;
const MAX_LENGTH = 12;
const SEPARATORS = /[\s-]+/g;
const ALNUM = /^[A-Z0-9]+$/;
const REGION = '(?:01|10|20|25|30|40|50|60|70|75|80|85|90|95)';
const LAYOUT_LETTER_FIRST = new RegExp(`^(${REGION})([A-Z])(\\d{3})([A-Z]{2})$`);
const LAYOUT_DIGITS_FIRST = new RegExp(`^(${REGION})(\\d{3})([A-Z]{3})$`);
const LAYOUT_SHORT = new RegExp(`^(${REGION})([A-Z])(\\d{4})$`);

export type PlateProblem = 'ascii' | 'length' | 'charset' | 'mix';

export type PlateCheck = { ok: true; plate: string } | { ok: false; reason: PlateProblem };

/** Upper-case without spaces, tabs or dashes. Does not validate. */
export function normalizePlate(raw: string): string {
  return raw.replace(SEPARATORS, '').toUpperCase();
}

/** Same rules, same order as the backend: ASCII, 5-12 characters, letters/digits, both kinds present. */
export function validatePlate(raw: string): PlateCheck {
  const compact = raw.replace(SEPARATORS, '');
  if (!/^[\u0000-\u007f]*$/.test(compact)) return { ok: false, reason: 'ascii' };
  const plate = compact.toUpperCase();
  if (plate.length < MIN_LENGTH || plate.length > MAX_LENGTH) return { ok: false, reason: 'length' };
  if (!ALNUM.test(plate)) return { ok: false, reason: 'charset' };
  if (!/\d/.test(plate) || !/[A-Z]/.test(plate)) return { ok: false, reason: 'mix' };
  return { ok: true, plate };
}

/** Known Uzbekistan layouts; informational only (foreign and temporary plates are legitimate). */
export function isStandardUzPlate(plate: string): boolean {
  return LAYOUT_LETTER_FIRST.test(plate) || LAYOUT_DIGITS_FIRST.test(plate) || LAYOUT_SHORT.test(plate);
}

/** "01A123BC" -> "01 A 123 BC"; anything non-standard is shown as stored. */
export function formatPlate(plate: string): string {
  const match = LAYOUT_LETTER_FIRST.exec(plate) ?? LAYOUT_DIGITS_FIRST.exec(plate) ?? LAYOUT_SHORT.exec(plate);
  return match ? match.slice(1).join(' ') : plate;
}
