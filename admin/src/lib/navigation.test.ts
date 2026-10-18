import { describe, expect, it } from 'vitest'
import { navItemsFor, selectedNavPath } from './navigation'

describe('navigation', () => {
  it('shows ADMIN every section', () => {
    const paths = navItemsFor('ADMIN').map((i) => i.path)
    expect(paths).toEqual(expect.arrayContaining(['/settings', '/audit', '/users', '/moderation']))
  })

  it('hides super admin sections from OWNER', () => {
    const paths = navItemsFor('OWNER').map((i) => i.path)
    for (const hidden of ['/settings', '/audit', '/users', '/moderation']) {
      expect(paths).not.toContain(hidden)
    }
    expect(paths).toContain('/operators')
    expect(paths).toContain('/bookings')
  })

  it('shows nothing to other roles', () => {
    expect(navItemsFor('DRIVER')).toEqual([])
    expect(navItemsFor(null)).toEqual([])
  })

  it('selects the owning menu entry for nested paths', () => {
    expect(selectedNavPath('/bookings/abc')).toBe('/bookings')
    expect(selectedNavPath('/parkings/new')).toBe('/parkings')
    expect(selectedNavPath('/nothing')).toBeUndefined()
  })
})
