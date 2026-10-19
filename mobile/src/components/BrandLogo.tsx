import { Image, StyleSheet, useColorScheme, View } from 'react-native';

import { FULL_LOGO_SIZE, MARK_LOGO_SIZE, aspectRatio } from '@/components/brandAssets';
import { APP_NAME } from '@/lib/constants';

// Aspect ratios of the derived assets (docs/brand/README.md); brandAssets.test.ts pins them to the files.
const FULL_RATIO = aspectRatio(FULL_LOGO_SIZE);
const MARK_RATIO = aspectRatio(MARK_LOGO_SIZE);
const FULL = require('../../assets/images/parkbor-logo.png') as number;
const MARK = require('../../assets/images/parkbor-mark.png') as number;

interface BrandLogoProps {
  variant?: 'full' | 'mark';
  /** Width in dp; the height follows the artwork. */
  width?: number;
}

/**
 * The ParkBor logo. The wordmark's dark blue "Park" disappears on a dark background, so in dark mode
 * the artwork sits on a white rounded plate (the mark alone is readable on both).
 */
export function BrandLogo({ variant = 'full', width = 240 }: BrandLogoProps) {
  const isDark = useColorScheme() === 'dark';
  const ratio = variant === 'full' ? FULL_RATIO : MARK_RATIO;
  const needsPlate = isDark && variant === 'full';
  return (
    <View style={needsPlate ? styles.plate : undefined}>
      <Image
        source={variant === 'full' ? FULL : MARK}
        accessibilityLabel={APP_NAME}
        accessibilityRole="image"
        resizeMode="contain"
        style={{ width, height: width / ratio }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  plate: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 12 },
});
