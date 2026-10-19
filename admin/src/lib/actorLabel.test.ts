import { describe, expect, it } from 'vitest'
import { actorLabel } from './actorLabel'

const t = ((key: string) => key) as never

describe('actorLabel', () => {
  it('translates the role labels', () => {
    for (const role of ['driver', 'operator', 'owner', 'admin', 'system']) {
      expect(actorLabel(role, t)).toBe(`bookings.actors.${role}`)
    }
  })

  it('treats null as the system and shows unknown values as plain text', () => {
    expect(actorLabel(null, t)).toBe('bookings.actors.system')
    expect(actorLabel('robot', t)).toBe('robot')
  })
})
