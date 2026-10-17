import type { CSSProperties } from 'react'

/** Layout constants shared by the auth screens (kept out of JSX to avoid magic numbers). */
export const LOGIN_CARD_WIDTH_PX = 360
export const PAGE_PADDING_PX = 16
export const WIDGET_MIN_HEIGHT_PX = 40

export const FULL_HEIGHT_CENTER: CSSProperties = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'center',
}
