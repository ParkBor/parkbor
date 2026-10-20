import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackHeader } from '@/components/BackHeader';
import { Button } from '@/components/Button';
import { formatRating } from '@/features/map/format';
import { describeParking } from '@/features/map/parkingText';
import type { NearbyResponse, Parking } from '@/features/map/schemas';
import { useLanguage } from '@/features/map/useLanguage';
import { findCachedParking, isValidParkingId } from '@/features/parking/parkingView';
import { SlotRows } from '@/features/parking/SlotRows';
import { useSlotAvailability } from '@/features/parking/useSlotAvailability';
import { useRealtimeGroups } from '@/features/realtime/useRealtime';
import { firstParam, formatCoordParam } from '@/features/route/lotParams';
import { usePalette } from '@/theme/theme';
import { useScreenLayout } from '@/theme/useScreenLayout';

/** parking/[id]: lot facts from the nearby cache + live free spots per type for the next hour. */
export function ParkingDetailScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const { column } = useScreenLayout();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = firstParam(params.id);
  if (!isValidParkingId(id)) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: p.background }]}>
        <View style={[styles.body, column]}>
          <Text style={{ color: p.text }}>{t('parking.invalid')}</Text>
          <Button label={t('common.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} />
        </View>
      </SafeAreaView>
    );
  }
  return <ParkingDetail lotId={id} />;
}

function ParkingDetail({ lotId }: { lotId: string }) {
  const { t } = useTranslation();
  const p = usePalette();
  const { column, gutter } = useScreenLayout();
  const router = useRouter();
  const queryClient = useQueryClient();
  const lot = findCachedParking(
    queryClient.getQueriesData<NearbyResponse>({ queryKey: ['parkings', 'nearby'] }).map(([, data]) => data),
    lotId,
  );
  const slots = useSlotAvailability(lotId, true);
  // lot_<id>: a snapshot on subscribe, then changes; the cache bridge refetches the per-type rows.
  useRealtimeGroups([{ kind: 'lot', id: lotId }]);

  const startRoute = (): void => {
    if (!lot) return;
    router.push({
      pathname: '/navigate/[parkingId]',
      params: { parkingId: lot.id, lat: formatCoordParam(lot.location.lat), lng: formatCoordParam(lot.location.lng), name: lot.name },
    });
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: p.background }]}>
      <ScrollView contentContainerStyle={[styles.body, { padding: gutter }, column]}>
        <BackHeader />
        <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
          {lot?.name ?? t('parking.title')}
        </Text>
        {lot?.address ? <Text style={{ color: p.textMuted }}>{lot.address}</Text> : null}
        {lot ? <ParkingFacts lot={lot} /> : <Text style={{ color: p.warningText }}>{t('parking.notCached')}</Text>}
        <SlotRows slots={slots} />
        <Text style={[styles.hint, { color: p.textMuted }]}>{t('parking.moreLater')}</Text>
        <View style={styles.actions}>
          <View style={styles.action}>
            <Button variant="secondary" label={t('parking.route')} disabled={!lot} onPress={startRoute} />
          </View>
          <View style={styles.action}>
            <Button label={t('parking.book')} onPress={() => router.push({ pathname: '/booking/new', params: { lotId } })} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ParkingFacts({ lot }: { lot: Parking }) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const text = describeParking(lot, lang);
  const rating = formatRating(lot.rating, lang);
  const openLabel = lot.isOpen ? t('map.open') : t('map.closed');
  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
      <Text style={{ color: lot.isOpen ? p.successText : p.textMuted }}>{`${t('parking.status')}: ${openLabel}`}</Text>
      <Text style={[styles.price, { color: p.text }]}>{text.price ?? t('map.priceUnknown')}</Text>
      <Text style={{ color: p.textMuted }}>
        {[text.distance, text.duration, rating ? `★ ${rating}` : t('map.unrated')].filter(Boolean).join(' · ')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 },
  price: { fontSize: 18, fontWeight: '700' },
  hint: { fontSize: 13 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
  action: { flex: 1, minWidth: 140 },
});
