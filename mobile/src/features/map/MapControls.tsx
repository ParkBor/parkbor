import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { LocationBanner } from '@/features/map/LocationBanner';
import type { UserLocationState } from '@/features/map/UserLocation';
import { TIGHT_FONT_MULTIPLIER } from '@/theme/layout';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface FloatingButtonProps {
  glyph: string;
  label: string;
  badge?: number;
  onPress: () => void;
}

function FloatingButton({ glyph, label, badge = 0, onPress }: FloatingButtonProps) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.fab, { backgroundColor: p.background, borderColor: p.border }]}
    >
      <Text maxFontSizeMultiplier={TIGHT_FONT_MULTIPLIER} style={[styles.fabGlyph, { color: p.text }]}>
        {glyph}
      </Text>
      {badge > 0 ? (
        <View style={[styles.badge, { backgroundColor: p.primary }]}>
          <Text maxFontSizeMultiplier={TIGHT_FONT_MULTIPLIER} style={[styles.badgeText, { color: p.onPrimary }]}>
            {badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

interface MapControlsProps {
  locationState: UserLocationState;
  filterCount: number;
  showSearchHere: boolean;
  isRefreshing: boolean;
  onRequestAccess: () => void;
  onOpenSettings: () => void;
  onOpenFilters: () => void;
  onBackToUser: () => void;
  onSearchHere: () => void;
}

/** Controls floating over the map: location banner, filters, locate-me, "search this area". */
export function MapControls(props: MapControlsProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { filterCount } = props;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.overlay, { paddingTop: insets.top + 8, paddingLeft: Math.max(12, insets.left), paddingRight: Math.max(12, insets.right) }]}
    >
      <View pointerEvents="box-none" style={styles.topRow}>
        <View style={styles.banner}>
          <LocationBanner
            state={props.locationState}
            onRequestAccess={props.onRequestAccess}
            onOpenSettings={props.onOpenSettings}
          />
        </View>
        <View style={styles.fabColumn}>
          <FloatingButton
            glyph="⚙"
            label={filterCount > 0 ? t('map.filtersActive', { count: filterCount }) : t('map.filters')}
            badge={filterCount}
            onPress={props.onOpenFilters}
          />
          <FloatingButton glyph="◎" label={t('map.backToUser')} onPress={props.onBackToUser} />
        </View>
      </View>
      {props.showSearchHere ? (
        <View style={styles.searchHere}>
          <Button label={t('map.searchHere')} onPress={props.onSearchHere} />
        </View>
      ) : null}
      {props.isRefreshing ? (
        <ActivityIndicator accessibilityLabel={t('map.loading')} color={p.primary} style={styles.spinner} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  banner: { flex: 1 },
  fabColumn: { gap: 8, marginLeft: 'auto' },
  fab: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },
  fabGlyph: { fontSize: 22 },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 20,
    minHeight: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { fontSize: 12, fontWeight: '700' },
  searchHere: { alignSelf: 'center', marginTop: 8 },
  spinner: { alignSelf: 'center', marginTop: 8 },
});
