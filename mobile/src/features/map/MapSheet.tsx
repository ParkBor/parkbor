import BottomSheet from '@gorhom/bottom-sheet';
import type { RefObject } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { NearbyParkings } from '@/features/map/useNearbyParkings';
import { ParkingPreview } from '@/features/map/ParkingPreview';
import { ParkingSheet } from '@/features/map/ParkingSheet';
import { useMapCredit } from '@/features/map/useMapCredit';
import type { Parking } from '@/features/map/schemas';
import type { RouteState } from '@/features/route/useRoute';
import { usePalette } from '@/theme/theme';
import { useScreenLayout } from '@/theme/useScreenLayout';

const SNAP_POINTS = ['18%', '46%', '88%'];
export const SHEET_DEFAULT_INDEX = 1;

interface MapSheetProps {
  sheetRef: RefObject<BottomSheet | null>;
  nearby: NearbyParkings;
  selected: Parking | null;
  onSelect: (parking: Parking) => void;
  onClosePreview: () => void;
  onRoute: (parking: Parking) => void;
  onStart: (parking: Parking) => void;
  onDetails: (parking: Parking) => void;
  onBook: (parking: Parking) => void;
  routeState: RouteState | null;
  onClearRoute: () => void;
  onOpenFilters: () => void;
}

/** Pull-up panel: the lot preview when one is selected, otherwise the nearby list. */
export function MapSheet({
  sheetRef,
  nearby,
  selected,
  onSelect,
  onClosePreview,
  onRoute,
  onStart,
  onDetails,
  onBook,
  routeState,
  onClearRoute,
  onOpenFilters,
}: MapSheetProps) {
  const p = usePalette();
  // Tablets / landscape: the sheet is the same centred column as every other screen.
  const { sideInset } = useScreenLayout();
  return (
    <BottomSheet
      ref={sheetRef}
      style={{ marginHorizontal: sideInset }}
      index={SHEET_DEFAULT_INDEX}
      snapPoints={SNAP_POINTS}
      enableDynamicSizing={false}
      backgroundStyle={{ backgroundColor: p.background }}
      handleComponent={SheetHandle}
    >
      {selected ? (
        <View style={styles.preview}>
          <ParkingPreview
            parking={selected}
            onClose={onClosePreview}
            onRoute={onRoute}
            onStart={onStart}
            onDetails={onDetails}
            onBook={onBook}
            routeState={routeState}
            onClearRoute={onClearRoute}
          />
        </View>
      ) : (
        <ParkingSheet
          parkings={nearby.parkings}
          isLoading={nearby.isLoading}
          error={nearby.error}
          expandedRadiusM={nearby.expandedRadiusM}
          onRetry={nearby.refetch}
          onSelect={onSelect}
          onOpenFilters={onOpenFilters}
        />
      )}
    </BottomSheet>
  );
}

/**
 * The sheet's grab handle also carries the map credit: whatever height the sheet is at, the handle (and so the
 * "© OpenStreetMap contributors" line the data licence requires) is on screen, never hidden behind the sheet.
 */
function SheetHandle() {
  const p = usePalette();
  const credit = useMapCredit();
  return (
    <View style={styles.handle}>
      <View style={[styles.grip, { backgroundColor: p.border }]} />
      <Text style={[styles.credit, { color: p.textMuted }]}>{credit}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { flex: 1 },
  handle: { alignItems: 'center', paddingTop: 8, paddingBottom: 6, paddingHorizontal: 12, gap: 4 },
  grip: { width: 36, height: 4, borderRadius: 2 },
  credit: { fontSize: 11, textAlign: 'center' },
});
