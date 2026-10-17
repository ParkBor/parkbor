import { z } from 'zod';

/**
 * The server answered 2xx but the body does not match the documented contract (ARCHITECTURE 9.5).
 * The message names the contract only: it NEVER carries response content (plates, tokens, ids).
 */
export class ContractError extends Error {
  constructor(what: string) {
    super(`Invalid ${what} response`);
    this.name = 'ContractError';
  }
}

/** ISO 8601 with an explicit UTC offset (`+05:00` or `Z`). A naive value is ambiguous: refused. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_PATTERN = /^\d{1,12}(?:\.\d{1,4})?$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Epoch milliseconds of an offset-bearing ISO string, or null. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `2026-10-15T09:00:00Z`: UTC, whole seconds, no `+` (nothing to URL-encode). */
export function isoInstant(ms: number): string {
  if (!Number.isFinite(ms)) throw new RangeError('Invalid instant');
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const instantSchema = z
  .string()
  .transform((value) => parseInstant(value))
  .refine((ms): ms is number => ms !== null, 'instant');

/** DRF serialises money as a string; a JSON number is a contract violation. */
export const moneySchema = z.string().regex(MONEY_PATTERN);

export const uuidSchema = z.string().refine(isUuid, 'uuid');
