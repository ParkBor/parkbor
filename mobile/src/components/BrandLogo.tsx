import { Image, StyleSheet, useColorScheme, View } from 'react-native';

import { APP_NAME } from '@/lib/constants';

// Aspect ratios of the derived assets (docs/brand/README.md).
const FULL_RATIO = 660 / 226;
const MARK_RATIO = 180 / 226;
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
