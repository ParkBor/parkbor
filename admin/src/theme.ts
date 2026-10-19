import type { ThemeConfig } from 'antd'

/**
 * ParkBor CRM brand tokens (colours sampled from docs/brand/parkbor-logo-original.png).
 *
 *   logo "Park" blue  #0056B4 -> colorPrimary as is (7.0:1 against white: AAA for text and buttons)
 *   logo pin blue     #0478E9 -> NOT used for text (4.3:1 fails AA); decoration only (the logo itself)
 *   logo "Bor" green  #3BC654 -> only in the logo (2.2:1 against white fails AA)
 *   colorSuccess      #1B7F36 -> the logo green darkened until white-on-green and green-on-white pass
 *                                AA (5.1:1); hover blue #0A66CC is 5.6:1.
 * The panel has no dark mode, so there is one palette (light); the sider is light too because the
 * wordmark's blue does not read on a dark background.
 */
export const BRAND = {
  primary: '#0056B4',
  primaryHover: '#0A66CC',
  primaryActive: '#00468F',
  success: '#1B7F36',
  pinBlue: '#0478E9',
  logoGreen: '#3BC654',
} as const

export const BORDER_RADIUS_PX = 6

export const theme: ThemeConfig = {
  token: {
    colorPrimary: BRAND.primary,
    colorPrimaryHover: BRAND.primaryHover,
    colorPrimaryActive: BRAND.primaryActive,
    colorInfo: BRAND.primary,
    colorLink: BRAND.primary,
    colorLinkHover: BRAND.primaryHover,
    colorLinkActive: BRAND.primaryActive,
    colorSuccess: BRAND.success,
    borderRadius: BORDER_RADIUS_PX,
  },
  components: {
    Layout: { siderBg: '#ffffff', headerBg: '#ffffff' },
    Menu: { itemSelectedBg: '#E8F1FB', itemSelectedColor: BRAND.primary },
  },
}

function channel(hex: string, start: number): number {
  const c = Number.parseInt(hex.slice(start, start + 2), 16) / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

/** WCAG contrast ratio of two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
