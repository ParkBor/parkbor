import { z } from 'zod';

import { isTrustedBotUrl, isValidLoginToken } from '@/features/auth/loginLink';

/** Persisted copy of the login in progress: survives Android killing the app while the user is in Telegram. */
export interface StoredLoginSession {
  loginToken: string;
  botUrl: string;
  expiresAt: number;
}

export interface LoginSessionSlot {
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
  clear: () => Promise<void>;
}

const storedSchema = z.object({
  loginToken: z.string(),
  botUrl: z.string(),
  expiresAt: z.number().finite(),
});

export function serializeLoginSession(session: StoredLoginSession): string {
  return JSON.stringify({ loginToken: session.loginToken, botUrl: session.botUrl, expiresAt: session.expiresAt });
}

/**
 * A stored session is trusted only if it passes the SAME checks as a fresh one (token shape, bot URL
 * that is exactly ours) and has not expired. The 6-digit code is never stored.
 */
export function parseLoginSession(raw: string | null, nowMs: number, botName: string): StoredLoginSession | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = storedSchema.safeParse(json);
  if (!parsed.success) return null;
  const { loginToken, botUrl, expiresAt } = parsed.data;
  if (!isValidLoginToken(loginToken) || !isTrustedBotUrl(botUrl, loginToken, botName)) return null;
  if (expiresAt <= nowMs) return null;
  return { loginToken, botUrl, expiresAt };
}
