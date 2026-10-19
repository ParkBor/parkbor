import { describe, expect, it } from 'vitest'
import { BRAND, contrastRatio, theme } from './theme'

const AA_TEXT = 4.5

describe('brand theme contrast (WCAG AA)', () => {
  it('computes known ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })

  it.each([
    ['primary', BRAND.primary],
    ['primary hover', BRAND.primaryHover],
    ['primary active', BRAND.primaryActive],
    ['success', BRAND.success],
  ])('%s passes AA with white text and on a white page', (_name, color) => {
    expect(contrastRatio(color, '#ffffff')).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('selected menu text passes AA on its highlight', () => {
    expect(contrastRatio(BRAND.primary, '#E8F1FB')).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('documents why the raw logo greens and light blue are not used for text', () => {
    expect(contrastRatio(BRAND.logoGreen, '#ffffff')).toBeLessThan(AA_TEXT)
    expect(contrastRatio(BRAND.pinBlue, '#ffffff')).toBeLessThan(AA_TEXT)
  })

  it('applies the tokens', () => {
    expect(theme.token?.colorPrimary).toBe(BRAND.primary)
    expect(theme.token?.colorSuccess).toBe(BRAND.success)
    expect(theme.token?.borderRadius).toBe(6)
  })
})
