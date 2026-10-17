import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import type { RefObject } from 'react';

import type { NearbyParkings } from '@/features/map/useNearbyParkings';
import { ParkingPreview } from '@/features/map/ParkingPreview';
import { ParkingSheet } from '@/features/map/ParkingSheet';
import type { Parking } from '@/features/map/schemas';
import type { RouteState } from '@/features/route/useRoute';
import { usePalette } from '@/theme/theme';

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
  routeState,
  onClearRoute,
  onOpenFilters,
}: MapSheetProps) {
  const p = usePalette();
  return (
    <BottomSheet
      ref={sheetRef}
      index={SHEET_DEFAULT_INDEX}
      snapPoints={SNAP_POINTS}
      enableDynamicSizing={false}
      backgroundStyle={{ backgroundColor: p.background }}
      handleIndicatorStyle={{ backgroundColor: p.border }}
    >
      {selected ? (
        <BottomSheetView>
          <ParkingPreview
            parking={selected}
            onClose={onClosePreview}
            onRoute={onRoute}
            onStart={onStart}
            onDetails={onDetails}
            routeState={routeState}
            onClearRoute={onClearRoute}
          />
        </BottomSheetView>
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
