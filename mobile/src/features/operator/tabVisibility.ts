import { z } from 'zod';

import type { User } from '@/lib/types';

// Hiding the Operator tab is a convenience only. Every operator endpoint checks the role (and the
// lot) on the server on every request; nothing here grants any access.

type Role = string | null | undefined;

export function isOperatorRole(role: Role): boolean {
  return role === 'OPERATOR';
}

export function isOwnerOrAdmin(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Roles whose requests to /operator/* can succeed at all; a driver never calls them. */
export function shouldFetchOperatorLots(role: Role): boolean {
  return isOperatorRole(role) || isOwnerOrAdmin(role);
}

/** Exit without the driver's QR (override + written reason): OWNER / ADMIN only. */
export function canOverrideExit(role: Role): boolean {
  return isOwnerOrAdmin(role);
}

/** `force` when taking a slot with waiting bookings out of service: OWNER / ADMIN only. */
export function canForceSlot(role: Role): boolean {
  return isOwnerOrAdmin(role);
}

export interface TabInput {
  role: Role;
  /** Number of lots GET /operator/parkings returned; null while unknown (not loaded / failed). */
  lotCount: number | null;
}

/**
 * OPERATOR: always (an operator with no lot yet sees an explanatory empty state).
 * OWNER / ADMIN: only when they have lots to work in. Everyone else (and unknown roles): never.
 */
export function operatorTabVisible({ role, lotCount }: TabInput): boolean {
  if (isOperatorRole(role)) return true;
  return isOwnerOrAdmin(role) && lotCount !== null && lotCount > 0;
}

const ROLES = ['DRIVER', 'OPERATOR', 'OWNER', 'ADMIN'] as const;
const meRoleSchema = z.object({ id: z.union([z.number(), z.string()]), role: z.enum(ROLES) });

/**
 * After refetching /me: the user to store when the ROLE changed for the SAME account, else null.
 * Only `id` and a known `role` are read from the answer (zod), so a stray body cannot invent a
 * role; other fields are left alone so it cannot rewrite the profile mid-edit.
 *
 * Staff tab note: until GET /operator/parkings has answered, an OWNER / ADMIN has no Operator tab
 * (`lotCount` is null) - the safe default; an OPERATOR sees it at once.
 */
export function nextUserForRole(current: User | null, fetched: unknown): User | null {
  const parsed = meRoleSchema.safeParse(fetched);
  if (current === null || !parsed.success) return null;
  if (String(parsed.data.id) !== String(current.id)) return null;
  return parsed.data.role === current.role ? null : { ...current, role: parsed.data.role };
}
