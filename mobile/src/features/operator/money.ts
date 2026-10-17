/**
 * True when a server decimal string ("0", "0.00", "000.0") is zero. Money stays a string: the app
 * never turns it into a float and never computes amounts (the server is the only source).
 * Anything that is not a plain non-negative decimal (empty, ".", "x") is NOT zero: unknown money
 * must never be read as "nothing to collect".
 */
export function isZeroMoney(value: string): boolean {
  return /^(?=\d|\.\d)0*(?:\.0*)?$/.test(value);
}
