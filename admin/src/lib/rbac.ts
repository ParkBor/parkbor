import type { UserRole } from '@habi/api-client'

// UI-only role map (docs/ARCHITECTURE.md 14.1/14.2). It hides menu items and buttons and guards
// routes so a wrong role never sees a broken screen; the REAL check is the backend permission
// class on every request. Roles come from GET /me, never from the JWT.

export type Feature =
  | 'dashboard'
  | 'parkings'
  | 'zonesSlots'
  | 'tariffs'
  | 'bookings'
  | 'overstay'
  | 'payments'
  | 'operators'
  | 'reviews'
  | 'moderation'
  | 'users'
  | 'settings'
  | 'audit'

export type Action =
  | 'booking.cancel'
  | 'refund.resolve'
  | 'lot.moderate'
  | 'review.moderate'
  | 'user.manage'
  | 'settings.edit'
  | 'operators.manage'
  | 'export'

type StaffRole = Extract<UserRole, 'OWNER' | 'ADMIN'>
const ADMIN_ONLY: readonly StaffRole[] = ['ADMIN']
const BOTH: readonly StaffRole[] = ['OWNER', 'ADMIN']

const FEATURE_ROLES: Record<Feature, readonly StaffRole[]> = {
  dashboard: BOTH,
  parkings: BOTH,
  zonesSlots: BOTH,
  tariffs: BOTH,
  bookings: BOTH,
  overstay: BOTH,
  payments: BOTH, // OWNER: read only (see ACTION_ROLES)
  operators: BOTH,
  reviews: BOTH, // OWNER: read only
  moderation: ADMIN_ONLY,
  users: ADMIN_ONLY,
  settings: ADMIN_ONLY,
  audit: ADMIN_ONLY,
}

const ACTION_ROLES: Record<Action, readonly StaffRole[]> = {
  'booking.cancel': BOTH,
  'refund.resolve': ADMIN_ONLY,
  'lot.moderate': ADMIN_ONLY,
  'review.moderate': ADMIN_ONLY,
  'user.manage': ADMIN_ONLY,
  'settings.edit': ADMIN_ONLY,
  'operators.manage': BOTH,
  export: BOTH,
}

type MaybeRole = UserRole | null | undefined

function includesRole(roles: readonly StaffRole[], role: MaybeRole): boolean {
  return role === 'OWNER' || role === 'ADMIN' ? roles.includes(role) : false
}

export function canAccess(role: MaybeRole, feature: Feature): boolean {
  return includesRole(FEATURE_ROLES[feature], role)
}

export function can(role: MaybeRole, action: Action): boolean {
  return includesRole(ACTION_ROLES[action], role)
}

/** Granting ADMIN, blocking an ADMIN and changing settings are for a super admin only. */
export function isSuperAdmin(
  user: { role: UserRole; is_superuser?: boolean } | null | undefined,
): boolean {
  return user?.role === 'ADMIN' && user.is_superuser === true
}

export function visibleFeatures(role: MaybeRole): Feature[] {
  return (Object.keys(FEATURE_ROLES) as Feature[]).filter((feature) => canAccess(role, feature))
}
