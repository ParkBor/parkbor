import { useMemo } from 'react';
import { useWindowDimensions, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CONTENT_MAX_WIDTH, layoutFor, type Layout } from '@/theme/layout';

export interface ScreenLayout extends Layout {
  insets: { top: number; right: number; bottom: number; left: number };
  /** Style for a full-width wrapper that should be the centred, width-capped column. */
  column: ViewStyle;
}

/** Live layout of the current window: breakpoints, centred column style and safe-area insets. */
export function useScreenLayout(): ScreenLayout {
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return useMemo(() => {
    const layout = layoutFor(width, height, fontScale);
    return { ...layout, insets, column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' } };
  }, [width, height, fontScale, insets]);
}
