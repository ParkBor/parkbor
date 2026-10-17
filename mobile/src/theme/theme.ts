import { useColorScheme } from 'react-native';

import { darkPalette, lightPalette, type Palette } from '@/theme/palette';

export type { Palette };

/** Minimum touch target, dp (design rule 13.3). */
export const MIN_TOUCH = 48;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? darkPalette : lightPalette;
}
