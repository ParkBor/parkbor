import { useColorScheme } from 'react-native';

import { getMapConfig } from '@/lib/config';

/** The credit line for the map style in use (light / dark). Always contains "© OpenStreetMap contributors". */
export function useMapCredit(): string {
  const isDark = useColorScheme() === 'dark';
  const { attribution } = getMapConfig();
  return isDark ? attribution.dark : attribution.light;
}
