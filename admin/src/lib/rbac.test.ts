import { describe, expect, it } from 'vitest'
import { can, canAccess, isSuperAdmin, visibleFeatures } from './rbac'

describe('canAccess (UI hint only; the server decides)', () => {
  it('lets ADMIN into everything', () => {
    for (const feature of visibleFeatures('ADMIN')) expect(canAccess('ADMIN', feature)).toBe(true)
    expect(canAccess('ADMIN', 'settings')).toBe(true)
    expect(canAccess('ADMIN', 'audit')).toBe(true)
    expect(canAccess('ADMIN', 'users')).toBe(true)
  })

  it('keeps OWNER out of the super admin sections', () => {
    for (const feature of ['settings', 'audit', 'users', 'moderation'] as const) {
      expect(canAccess('OWNER', feature)).toBe(false)
    }
  })

  it('gives OWNER the sections of their own lots', () => {
    for (const feature of [
      'dashboard',
      'parkings',
      'zonesSlots',
      'tariffs',
      'bookings',
      'overstay',
      'payments',
      'operators',
      'reviews',
    ] as const) {
      expect(canAccess('OWNER', feature)).toBe(true)
    }
  })

  it.each([null, undefined, 'DRIVER', 'OPERATOR'] as const)('denies everything to %j', (role) => {
    expect(visibleFeatures(role)).toEqual([])
    expect(canAccess(role, 'dashboard')).toBe(false)
  })
})

describe('can (write actions)', () => {
  it('reserves refund resolution, moderation, user management and settings for ADMIN', () => {
    for (const action of [
      'refund.resolve',
      'lot.moderate',
      'review.moderate',
      'user.manage',
      'settings.edit',
    ] as const) {
      expect(can('ADMIN', action)).toBe(true)
      expect(can('OWNER', action)).toBe(false)
    }
  })

  it('lets OWNER cancel bookings, manage operators and export', () => {
    expect(can('OWNER', 'booking.cancel')).toBe(true)
    expect(can('OWNER', 'operators.manage')).toBe(true)
    expect(can('OWNER', 'export')).toBe(true)
  })

  it('denies unknown roles', () => {
    expect(can(null, 'export')).toBe(false)
    expect(can('DRIVER', 'export')).toBe(false)
  })
})

describe('isSuperAdmin', () => {
  it('needs the ADMIN role AND is_superuser from /me', () => {
    expect(isSuperAdmin({ role: 'ADMIN', is_superuser: true })).toBe(true)
    expect(isSuperAdmin({ role: 'ADMIN', is_superuser: false })).toBe(false)
    expect(isSuperAdmin({ role: 'ADMIN' })).toBe(false)
    expect(isSuperAdmin({ role: 'OWNER', is_superuser: true })).toBe(false)
    expect(isSuperAdmin(null)).toBe(false)
  })
})
