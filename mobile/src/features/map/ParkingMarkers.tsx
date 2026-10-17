import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { Marker } from 'react-native-maps';

import {
  buildClusterIndex,
  clusterExpansionRegion,
  getMapItems,
  type ClusterIndex,
} from '@/features/map/cluster';
import type { Region } from '@/features/map/geo';
import { markerColor, markerFill, markerLabel, readableTextColor, type MarkerKind } from '@/features/map/markerColor';
import type { Parking } from '@/features/map/schemas';
import { usePalette } from '@/theme/theme';

/** Custom marker views must be re-rasterised by the map; stop tracking once they settle. */
const TRACK_VIEW_CHANGES_MS = 400;
const MARKER_SIZE = 48;

/** True until the marker content (identified by `signature`) has been stable for a moment. */
function useSettledTracking(signature: string): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(signature), TRACK_VIEW_CHANGES_MS);
    return () => clearTimeout(timer);
  }, [signature]);
  return settled !== signature;
}

interface BadgeProps {
  kind: MarkerKind;
  label: string;
  isCluster: boolean;
  isSelected: boolean;
}

function Badge({ kind, label, isCluster, isSelected }: BadgeProps) {
  const p = usePalette();
  const fill = markerFill(kind, p);
  return (
    <View
      style={[
        styles.badge,
        isCluster ? styles.cluster : styles.lot,
        { backgroundColor: fill, borderColor: isSelected ? p.primary : p.background },
        isSelected && styles.selected,
      ]}
    >
      <Text style={[styles.badgeText, { color: readableTextColor(fill) }]}>{label}</Text>
    </View>
  );
}

interface LotMarkerProps {
  parking: Parking;
  isSelected: boolean;
  onSelect: (parking: Parking) => void;
}

const LotMarker = memo(function LotMarker({ parking, isSelected, onSelect }: LotMarkerProps) {
  const { t } = useTranslation();
  const kind = markerColor(parking.freeSlots, parking.totalSlots, parking.isOpen);
  const label = markerLabel(parking.freeSlots, parking.isOpen);
  const isTracking = useSettledTracking(`${kind}|${label}|${isSelected}`);
  const a11y = parking.isOpen
    ? t('map.markerLabel', { name: parking.name, free: parking.freeSlots })
    : t('map.markerClosedLabel', { name: parking.name });
  return (
    <Marker
      coordinate={{ latitude: parking.location.lat, longitude: parking.location.lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={isTracking}
      zIndex={isSelected ? 2 : 1}
      accessibilityLabel={a11y}
      onPress={(event) => {
        event.stopPropagation();
        onSelect(parking);
      }}
    >
      <Badge kind={kind} label={label} isCluster={false} isSelected={isSelected} />
    </Marker>
  );
});

interface ParkingMarkersProps {
  parkings: readonly Parking[];
  region: Region;
  selectedId: string | null;
  onSelect: (parking: Parking) => void;
  onZoomTo: (region: Region) => void;
}

/** Clustered, availability-colored markers for the current viewport. */
export function ParkingMarkers({ parkings, region, selectedId, onSelect, onZoomTo }: ParkingMarkersProps) {
  const { t } = useTranslation();
  const index: ClusterIndex = useMemo(() => buildClusterIndex(parkings), [parkings]);
  const items = useMemo(() => getMapItems(index, region), [index, region]);

  return (
    <>
      {items.map((item) => {
        if (item.type === 'parking') {
          return (
            <LotMarker
              key={`p-${item.parking.id}`}
              parking={item.parking}
              isSelected={item.parking.id === selectedId}
              onSelect={onSelect}
            />
          );
        }
        return (
          <ClusterMarker
            key={`c-${item.id}`}
            label={String(item.free)}
            kind={item.kind}
            a11y={t('map.clusterLabel', { count: item.count, free: item.free })}
            coordinate={{ latitude: item.lat, longitude: item.lng }}
            onPress={() => onZoomTo(clusterExpansionRegion(index, item.id, { latitude: item.lat, longitude: item.lng }))}
          />
        );
      })}
    </>
  );
}

interface ClusterMarkerProps {
  label: string;
  kind: MarkerKind;
  a11y: string;
  coordinate: { latitude: number; longitude: number };
  onPress: () => void;
}

function ClusterMarker({ label, kind, a11y, coordinate, onPress }: ClusterMarkerProps) {
  const isTracking = useSettledTracking(`${kind}|${label}`);
  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={isTracking}
      accessibilityLabel={a11y}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
    >
      <Badge kind={kind} label={label} isCluster isSelected={false} />
    </Marker>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: MARKER_SIZE,
    height: MARKER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    paddingHorizontal: 6,
  },
  cluster: { borderRadius: MARKER_SIZE / 2 },
  lot: { borderRadius: 14 },
  selected: { borderWidth: 4 },
  badgeText: { fontSize: 16, fontWeight: '800' },
});
