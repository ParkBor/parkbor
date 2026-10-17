import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { markerFill } from '@/features/map/markerColor';
import { describeParking } from '@/features/map/parkingText';
import type { Parking } from '@/features/map/schemas';
import { useLanguage } from '@/features/map/useLanguage';
import { RoutePreviewSummary } from '@/features/route/RouteNotices';
import type { RouteState } from '@/features/route/useRoute';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface ParkingPreviewProps {
  parking: Parking;
  onClose: () => void;
  onRoute: (parking: Parking) => void;
  onStart: (parking: Parking) => void;
  onDetails: (parking: Parking) => void;
  /** Route requested for this lot (null = none yet). */
  routeState: RouteState | null;
  onClearRoute: () => void;
}

/** Card shown in the bottom sheet after a marker is tapped. */
export function ParkingPreview({
  parking,
  onClose,
  onRoute,
  onStart,
  onDetails,
  routeState,
  onClearRoute,
}: ParkingPreviewProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const text = describeParking(parking, lang);
  const status = parking.isOpen ? t('map.open') : t('map.closed');

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text accessibilityRole="header" style={[styles.name, { color: p.text }]}>
            {parking.name}
          </Text>
          {parking.address ? <Text style={{ color: p.textMuted }}>{parking.address}</Text> : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('map.closePreview')}
          onPress={onClose}
          style={styles.close}
        >
          <Text style={[styles.closeGlyph, { color: p.text }]}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.facts}>
        <View style={styles.freeRow}>
          <View style={[styles.dot, { backgroundColor: markerFill(text.kind, p) }]} />
          <Text style={[styles.free, { color: p.text }]}>
            {t('map.freeOfTotal', { free: parking.freeSlots, total: parking.totalSlots })}
          </Text>
          <Text style={{ color: parking.isOpen ? p.successText : p.textMuted }}>{status}</Text>
        </View>
        <Text style={[styles.price, { color: p.text }]}>{text.price ?? t('map.priceUnknown')}</Text>
        <Text style={{ color: p.textMuted }}>
          {[text.distance, text.duration, text.rating ? `★ ${text.rating}` : t('map.unrated')]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>

      {routeState ? <RoutePreviewSummary state={routeState} onClear={onClearRoute} /> : null}

      <View style={styles.actions}>
        <View style={styles.action}>
          <Button
            variant="secondary"
            label={t('map.route')}
            loading={routeState?.isLoading ?? false}
            onPress={() => onRoute(parking)}
          />
        </View>
        <View style={styles.action}>
          <Button label={t('route.start')} onPress={() => onStart(parking)} />
        </View>
      </View>
      <Button variant="secondary" label={t('map.details')} onPress={() => onDetails(parking)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  headerText: { flex: 1, gap: 2 },
  name: { fontSize: 20, fontWeight: '700' },
  close: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  closeGlyph: { fontSize: 20 },
  facts: { gap: 6 },
  freeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  free: { fontSize: 16, fontWeight: '700' },
  price: { fontSize: 18, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 12 },
  action: { flex: 1 },
});
