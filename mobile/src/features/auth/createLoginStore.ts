import { createStore, type StoreApi } from 'zustand/vanilla';
import { z } from 'zod';

import { codeSchema } from '@/features/auth/code';
import { isTrustedBotUrl, isValidLoginToken } from '@/features/auth/loginLink';
import { errorMessageKey, parseApiError } from '@/lib/errors';
import type { AuthResult, LoginStatus, LoginStatusResponse, StartLoginResponse } from '@/lib/types';

/** Backend: 5 wrong codes cancel the token. */
export const MAX_CODE_ATTEMPTS = 5;
const MAX_EXPIRES_IN_SECONDS = 3600;

export interface LoginApi {
  start(deviceId: string): Promise<StartLoginResponse>;
  status(loginToken: string): Promise<LoginStatusResponse>;
  verify(loginToken: string, code: string): Promise<AuthResult>;
}

export interface LoginDeps {
  api: LoginApi;
  openUrl: (url: string) => Promise<unknown>;
  getDeviceId: () => Promise<string>;
  /** Expected Telegram bot username (app.config extra.telegramBot). */
  botName: string;
  onAuthenticated: (result: AuthResult) => Promise<void>;
  now: () => number;
}

/** Held in memory only; never logged, never persisted, never put in route params. */
export interface LoginSession {
  loginToken: string;
  botUrl: string;
  expiresAt: number;
}

export type LoginErrorKey =
  | 'errors.network'
  | 'errors.throttled'
  | 'errors.invalidCode'
  | 'errors.codeExpired'
  | 'errors.notConfirmed'
  | 'errors.accountDisabled'
  | 'errors.server'
  | 'errors.generic'
  | 'errors.attemptsExhausted'
  | 'errors.cannotOpenTelegram'
  | 'validation.codeInvalid';

type Failure = { ok: false; errorKey: LoginErrorKey; /** The session is over; restart. */ fatal: boolean };

export type ActionResult<T> = { ok: true; value: T } | Failure;

export interface LoginState {
  session: LoginSession | null;
  failedAttempts: number;
  isConfirmed: boolean;
  /** A verify request is running (store-level guard against double submits). */
  isSubmitting: boolean;
  /** Why the session ended (shown on the code screen); null while active or after reset. */
  endedReason: LoginErrorKey | null;
  start: () => Promise<ActionResult<void>>;
  reopenBot: () => Promise<ActionResult<void>>;
  checkStatus: () => Promise<ActionResult<LoginStatus>>;
  submitCode: (code: string) => Promise<ActionResult<{ isNew: boolean }>>;
  reset: () => void;
}

const startSchema = z.object({
  login_token: z.string().refine(isValidLoginToken),
  bot_url: z.string(),
  expires_in: z.number().int().positive().max(MAX_EXPIRES_IN_SECONDS),
});

const statusSchema = z.object({ status: z.enum(['PENDING', 'CONFIRMED', 'EXPIRED']) });

const EMPTY = {
  session: null,
  failedAttempts: 0,
  isConfirmed: false,
  isSubmitting: false,
  endedReason: null,
} as const;

function fail(errorKey: LoginErrorKey, fatal = false): Failure {
  return { ok: false, errorKey, fatal };
}

function failFrom(error: unknown): Failure {
  const key = errorMessageKey(parseApiError(error));
  return fail(key, key === 'errors.codeExpired');
}

export function createLoginStore(deps: LoginDeps): StoreApi<LoginState> {
  return createStore<LoginState>()((set, get) => {
    /** Ends the session for good and remembers why. */
    function end(errorKey: LoginErrorKey): Failure {
      set({ ...EMPTY, endedReason: errorKey });
      return fail(errorKey, true);
    }

    async function open(session: LoginSession): Promise<ActionResult<void>> {
      try {
        await deps.openUrl(session.botUrl);
        return { ok: true, value: undefined };
      } catch {
        return fail('errors.cannotOpenTelegram');
      }
    }

    async function verify(session: LoginSession, code: string): Promise<ActionResult<{ isNew: boolean }>> {
      let result: AuthResult;
      try {
        result = await deps.api.verify(session.loginToken, code);
      } catch (error: unknown) {
        return handleVerifyError(error);
      }
      try {
        // Session stays until the auth layer is done, so screens do not flash back to login.
        await deps.onAuthenticated(result);
      } catch {
        return end('errors.generic'); // e.g. secure store refused to persist the tokens
      }
      set({ ...EMPTY });
      return { ok: true, value: { isNew: result.is_new } };
    }

    function handleVerifyError(error: unknown): Failure {
      const failure = failFrom(error);
      if (failure.fatal) return end(failure.errorKey);
      if (failure.errorKey !== 'errors.invalidCode') return failure;

      const failedAttempts = get().failedAttempts + 1;
      if (failedAttempts >= MAX_CODE_ATTEMPTS) return end('errors.attemptsExhausted');
      set({ failedAttempts });
      return failure;
    }

    return {
      ...EMPTY,

      async start() {
        let response: StartLoginResponse;
        try {
          response = await deps.api.start(await deps.getDeviceId());
        } catch (error: unknown) {
          return failFrom(error);
        }
        const parsed = startSchema.safeParse(response);
        if (
          !parsed.success ||
          !isTrustedBotUrl(parsed.data.bot_url, parsed.data.login_token, deps.botName)
        ) {
          return fail('errors.generic');
        }
        const session: LoginSession = {
          loginToken: parsed.data.login_token,
          botUrl: parsed.data.bot_url,
          expiresAt: deps.now() + parsed.data.expires_in * 1000,
        };
        set({ ...EMPTY, session });
        return open(session);
      },

      async reopenBot() {
        const { session } = get();
        return session ? open(session) : fail('errors.generic');
      },

      async checkStatus() {
        const { session } = get();
        if (!session) return fail('errors.generic');
        try {
          const parsed = statusSchema.safeParse(await deps.api.status(session.loginToken));
          if (!parsed.success) return fail('errors.generic');
          const { status } = parsed.data;
          if (status === 'EXPIRED') end('errors.codeExpired');
          if (status === 'CONFIRMED') set({ isConfirmed: true });
          return { ok: true, value: status };
        } catch (error: unknown) {
          return failFrom(error);
        }
      },

      async submitCode(code) {
        const { session, isSubmitting } = get();
        if (!session || isSubmitting) return fail('errors.generic');
        if (!codeSchema.safeParse(code).success) return fail('validation.codeInvalid');
        if (deps.now() >= session.expiresAt) return end('errors.codeExpired');

        set({ isSubmitting: true });
        try {
          return await verify(session, code);
        } finally {
          set({ isSubmitting: false });
        }
      },

      reset() {
        set({ ...EMPTY });
      },
    };
  });
}
