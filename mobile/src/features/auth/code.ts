import { z } from 'zod';

export const CODE_LENGTH = 6;
/** Clipboard text longer than this is never inspected. */
const MAX_CLIPBOARD_LENGTH = 500;

export const codeSchema = z.string().regex(/^[0-9]{6}$/, 'validation.codeInvalid');

/** Keeps ASCII digits only, at most CODE_LENGTH of them. */
export function sanitizeCode(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, CODE_LENGTH);
}

/** Finds the single standalone 6-digit code in free text (e.g. the bot message). */
export function extractCode(text: string): string | null {
  if (text.length === 0 || text.length > MAX_CLIPBOARD_LENGTH) return null;
  const found = text.match(/(?<![0-9])[0-9]{6}(?![0-9])/g);
  if (!found) return null;
  return new Set(found).size === 1 ? (found[0] ?? null) : null;
}

/** True when the clipboard holds exactly the code we filled in (safe to wipe after use). */
export function clipboardHoldsCode(clipboardText: string, usedCode: string): boolean {
  return extractCode(clipboardText) === usedCode;
}

export function toCells(code: string): string[] {
  return Array.from({ length: CODE_LENGTH }, (_, i) => code[i] ?? '');
}

export function remainingSeconds(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

export function formatTimer(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
