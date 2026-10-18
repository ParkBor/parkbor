import { canAccess, type Feature } from './rbac'
import type { UserRole } from '@habi/api-client'

export interface NavItem {
  path: string
  feature: Feature
  labelKey: string
}

/** Menu order. Visibility follows the role (a hint; every route is guarded and the API enforces). */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/dashboard', feature: 'dashboard', labelKey: 'nav.dashboard' },
  { path: '/parkings', feature: 'parkings', labelKey: 'nav.parkings' },
  { path: '/zones-slots', feature: 'zonesSlots', labelKey: 'nav.zonesSlots' },
  { path: '/tariffs', feature: 'tariffs', labelKey: 'nav.tariffs' },
  { path: '/bookings', feature: 'bookings', labelKey: 'nav.bookings' },
  { path: '/overstay', feature: 'overstay', labelKey: 'nav.overstay' },
  { path: '/payments', feature: 'payments', labelKey: 'nav.payments' },
  { path: '/refunds', feature: 'payments', labelKey: 'nav.refunds' },
  { path: '/operators', feature: 'operators', labelKey: 'nav.operators' },
  { path: '/users', feature: 'users', labelKey: 'nav.users' },
  { path: '/moderation', feature: 'moderation', labelKey: 'nav.moderation' },
  { path: '/reviews', feature: 'reviews', labelKey: 'nav.reviews' },
  { path: '/settings', feature: 'settings', labelKey: 'nav.settings' },
  { path: '/audit', feature: 'audit', labelKey: 'nav.audit' },
]

export function navItemsFor(role: UserRole | null | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => canAccess(role, item.feature))
}

/** The menu entry that owns a pathname (longest matching prefix). */
export function selectedNavPath(pathname: string): string | undefined {
  return NAV_ITEMS.filter((item) => pathname === item.path || pathname.startsWith(`${item.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path
}
