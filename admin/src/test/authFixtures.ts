import type { AuthUser, UserRole } from '@habi/api-client'
import { vi } from 'vitest'
import type { AuthState } from '../lib/auth'

export function makeUser(role: UserRole = 'ADMIN', isSuperuser = true): AuthUser {
  return {
    id: 'u1',
    telegram_id: 7,
    telegram_username: 'ali',
    phone: null,
    first_name: 'Ali',
    last_name: '',
    language: 'uz',
    role,
    tg_notifications: true,
    is_superuser: isSuperuser,
  }
}

interface AuthOverrides extends Partial<AuthState> {
  /** Shortcut: role of the signed-in user (null = authenticated without a user). */
  role?: UserRole | null
  /** is_superuser of the signed-in user (default true). */
  superuser?: boolean
}

/** An AuthState for component tests: an authenticated ADMIN unless told otherwise. */
export function makeAuth({ role, superuser = true, ...overrides }: AuthOverrides = {}): AuthState {
  const status = overrides.status ?? 'authenticated'
  const user = status === 'authenticated' && role !== null ? makeUser(role ?? 'ADMIN', superuser) : null
  return {
    status,
    user,
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    retry: vi.fn(),
    ...overrides,
  }
}

export function anonymousAuth(overrides: Partial<AuthState> = {}): AuthState {
  return makeAuth({ status: 'anonymous', ...overrides })
}
