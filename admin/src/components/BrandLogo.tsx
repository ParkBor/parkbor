import { useTranslation } from 'react-i18next'

interface BrandLogoProps {
  /** `logo` = pin + wordmark, `mark` = the pin alone (collapsed sider, narrow header). */
  variant?: 'logo' | 'mark'
  height?: number
  /** Next to a visible product name the image is decoration (empty alt). */
  decorative?: boolean
}

const LOGO_RATIO = 640 / 216 // parkbor-logo.png (transparent background; for light surfaces)

/** The ParkBor logo; the name is the accessible text, so it is not repeated as visible text. */
export function BrandLogo({ variant = 'logo', height = 36, decorative = false }: BrandLogoProps) {
  const { t } = useTranslation()
  const isMark = variant === 'mark'
  return (
    <img
      src={isMark ? '/parkbor-mark.png' : '/parkbor-logo.png'}
      alt={decorative ? '' : t('app.title')}
      height={height}
      width={isMark ? height : Math.round(height * LOGO_RATIO)}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}
