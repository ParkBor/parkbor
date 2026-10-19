import { Camera, Map, UserLocation, type CameraRef, type MapProps } from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useReducer, type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, useColorScheme, View, type DimensionValue } from 'react-native';

import { Button } from '@/components/Button';
import type { Region } from '@/features/map/geo';
import { INITIAL_MAP_LOAD, MAP_LOAD_TIMEOUT_MS, reduceMapLoad } from '@/features/map/mapLoadState';
import { boundsToRegion, regionToBounds } from '@/features/map/maplibreAdapter';
import { getMapConfig } from '@/lib/config';
import { usePalette } from '@/theme/theme';

interface AppMapProps {
  cameraRef: Ref<CameraRef>;
  initialRegion: Region;
  /** The viewport settled (after a pan, zoom or an animation). */
  onRegionSettled?: (region: Region) => void;
  /** The user dragged or pinched the map (not an animation we started). */
  onUserMove?: () => void;
  onPress?: () => void;
  showsUserLocation?: boolean;
  /** Distance of the credit line from the bottom edge (keep it above sheets and bars). */
  attributionBottom: DimensionValue;
  accessibilityLabel?: string;
  children?: ReactNode;
}

/**
 * The map: MapLibre with an OpenStreetMap vector style chosen by configuration (config.getMapConfig),
 * light or dark with the system theme. Always shows the credit line the data licence requires. If the
 * style cannot be loaded the map area becomes a short notice with "Try again" - everything layered on
 * top of it (lists, filters, sheets) keeps working.
 */
export function AppMap({
  cameraRef,
  initialRegion,
  onRegionSettled,
  onUserMove,
  onPress,
  showsUserLocation = false,
  attributionBottom,
  accessibilityLabel,
  children,
}: AppMapProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const isDark = useColorScheme() === 'dark';
  const config = useMemo(() => getMapConfig(), []);
  const [load, dispatch] = useReducer(reduceMapLoad, INITIAL_MAP_LOAD);

  useEffect(() => {
    if (load.status !== 'loading') return undefined;
    const timer = setTimeout(() => dispatch('timeout'), MAP_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [load.status, load.attempt]);

  const handleRegionChange: NonNullable<MapProps['onRegionDidChange']> = (event) => {
    const { bounds, userInteraction } = event.nativeEvent;
    const region = boundsToRegion(bounds);
    if (region) onRegionSettled?.(region);
    if (userInteraction) onUserMove?.();
  };

  return (
    <View style={StyleSheet.absoluteFill} accessibilityLabel={accessibilityLabel}>
      <Map
        key={load.attempt}
        style={StyleSheet.absoluteFill}
        mapStyle={isDark ? config.styles.dark : config.styles.light}
        // The credit line is drawn by <MapCredit/> below, always visible (not behind an "i" button).
        attribution={false}
        logo={false}
        compass={false}
        touchRotate={false}
        touchPitch={false}
        onDidFinishLoadingStyle={() => dispatch('loaded')}
        onDidFailLoadingMap={() => dispatch('failed')}
        onRegionDidChange={handleRegionChange}
        onPress={onPress}
      >
        <Camera ref={cameraRef} initialViewState={{ bounds: regionToBounds(initialRegion) }} />
        {showsUserLocation ? <UserLocation /> : null}
        {children}
      </Map>

      {load.status === 'failed' ? (
        <View style={[styles.failed, { backgroundColor: p.surface }]} accessibilityLiveRegion="polite">
          <Text style={[styles.failedTitle, { color: p.text }]}>{t('map.styleFailedTitle')}</Text>
          <Text style={[styles.failedText, { color: p.textMuted }]}>{t('map.styleFailedText')}</Text>
          <Button variant="secondary" label={t('common.retry')} onPress={() => dispatch('retry')} />
        </View>
      ) : null}

      <View pointerEvents="none" style={[styles.credit, { bottom: attributionBottom }]}>
        <Text
          accessibilityLabel={t('map.attributionLabel', { text: isDark ? config.attribution.dark : config.attribution.light })}
          style={[styles.creditText, { color: isDark ? '#E5E7EB' : '#111827', backgroundColor: isDark ? 'rgba(11,15,23,0.72)' : 'rgba(255,255,255,0.78)' }]}
        >
          {isDark ? config.attribution.dark : config.attribution.light}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  failed: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  failedTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  failedText: { fontSize: 14, textAlign: 'center' },
  credit: { position: 'absolute', left: 8, right: 8, alignItems: 'flex-start' },
  creditText: { fontSize: 11, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
});
