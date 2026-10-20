import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Chip } from '@/components/Chip';
import { activeFilterCount } from '@/features/map/filters';
import { filtersStore, useFiltersStore } from '@/features/map/filtersStore';
import { formatDistance } from '@/features/map/format';
import { markerFill } from '@/features/map/markerColor';
import type { MapErrorKind } from '@/features/map/mapError';
import { describeParking } from '@/features/map/parkingText';
import { SORT_MODES, type Parking } from '@/features/map/schemas';
import { ListSkeleton, MessageView } from '@/features/map/StateViews';
import { useLanguage } from '@/features/map/useLanguage';
import { MIN_TOUCH, usePalette } from '@/theme/theme';
import { useScreenLayout } from '@/theme/useScreenLayout';

interface ParkingSheetProps {
  parkings: readonly Parking[];
  isLoading: boolean;
  error: MapErrorKind | null;
  /** Radius the backend widened the search to (null when it did not). */
  expandedRadiusM: number | null;
  onRetry: () => void;
  onSelect: (parking: Parking) => void;
  onOpenFilters: () => void;
}

interface RowProps {
  parking: Parking;
  onSelect: (parking: Parking) => void;
}

function ParkingRow({ parking, onSelect }: RowProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const text = describeParking(parking, lang);
  const status = parking.isOpen ? t('map.open') : t('map.closed');
  const timing = [text.distance, text.duration].filter(Boolean).join(' · ');
  const label = t('map.itemLabel', {
    name: parking.name,
    distance: timing,
    free: parking.freeSlots,
    total: parking.totalSlots,
    status,
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onSelect(parking)}
      style={[styles.row, { backgroundColor: p.surface }]}
    >
      <View style={styles.rowTop}>
        <Text numberOfLines={1} style={[styles.rowName, { color: p.text }]}>
          {parking.name}
        </Text>
        <Text style={{ color: p.textMuted }}>{timing}</Text>
      </View>
      <View style={styles.rowBottom}>
        <View style={[styles.dot, { backgroundColor: markerFill(text.kind, p) }]} />
        <Text style={{ color: p.text }}>
          {parking.isOpen ? t('map.freeOfTotal', { free: parking.freeSlots, total: parking.totalSlots }) : t('map.closed')}
        </Text>
        <Text style={{ color: p.textMuted }}>· {text.price ?? t('map.priceUnknown')}</Text>
        {text.rating ? <Text style={{ color: p.textMuted }}>· ★ {text.rating}</Text> : null}
      </View>
    </Pressable>
  );
}

/** Pull-up list of nearby lots with the quick sort switch and all loading / empty / error states. */
export function ParkingSheet({
  parkings,
  isLoading,
  error,
  expandedRadiusM,
  onRetry,
  onSelect,
  onOpenFilters,
}: ParkingSheetProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const { insets } = useScreenLayout();
  const sort = useFiltersStore((s) => s.filters.sort);
  const hasActiveFilters = useFiltersStore((s) => activeFilterCount(s.filters) > 0);

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
          {t('map.sheetTitle')}
        </Text>
        {parkings.length > 0 ? (
          <Text style={{ color: p.textMuted }}>{t('map.sheetFound', { count: parkings.length })}</Text>
        ) : null}
      </View>
      <View style={styles.chips}>
        {SORT_MODES.map((mode) => (
          <Chip
            key={mode}
            label={t(`map.sort.${mode}`)}
            selected={sort === mode}
            onPress={() => filtersStore.getState().setSort(mode)}
          />
        ))}
      </View>
      {expandedRadiusM !== null ? (
        <Text style={{ color: p.textMuted }}>
          {t('map.radiusExpanded', { radius: formatDistance(expandedRadiusM, lang) })}
        </Text>
      ) : null}
      {error && parkings.length > 0 ? (
        <MessageView isError text={t(`map.error.${error}`)} actionLabel={t('common.retry')} onAction={onRetry} />
      ) : null}
    </View>
  );

  let empty = null;
  if (isLoading) {
    empty = <ListSkeleton />;
  } else if (error) {
    empty = <MessageView isError text={t(`map.error.${error}`)} actionLabel={t('common.retry')} onAction={onRetry} />;
  } else {
    empty = (
      <MessageView
        title={t('map.empty.title')}
        text={t('map.empty.text')}
        actionLabel={hasActiveFilters ? t('map.filter.reset') : t('map.filters')}
        onAction={hasActiveFilters ? () => filtersStore.getState().reset() : onOpenFilters}
      />
    );
  }

  return (
    <BottomSheetFlatList
      data={parkings}
      keyExtractor={(item: Parking) => item.id}
      renderItem={({ item }: { item: Parking }) => <ParkingRow parking={item} onSelect={onSelect} />}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      contentContainerStyle={[styles.content, { paddingBottom: 32 + insets.bottom }]}
      keyboardShouldPersistTaps="handled"
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32, gap: 8, paddingHorizontal: 16 },
  header: { gap: 12, paddingBottom: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { fontSize: 18, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { minHeight: MIN_TOUCH + 24, borderRadius: 12, padding: 14, gap: 6, justifyContent: 'center' },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  rowName: { flex: 1, fontSize: 16, fontWeight: '700' },
  rowBottom: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
