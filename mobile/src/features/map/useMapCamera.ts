import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useEffect, useRef, useState, type RefObject } from 'react';

import type { LatLng, Region } from '@/features/map/geo';
import { DEFAULT_CENTER } from '@/features/map/locationModel';
import { regionToBounds, runCamera } from '@/features/map/maplibreAdapter';
import { regionAround } from '@/features/map/search';

const MAP_ANIMATION_MS = 350;
const DEFAULT_RADIUS_M = 3000;

export interface MapCamera {
  initialRegion: Region;
  /** Latest settled viewport (drives clustering). */
  region: Region;
  setRegion: (region: Region) => void;
  markMoved: () => void;
  animateTo: (center: LatLng) => void;
  zoomTo: (region: Region) => void;
}

/**
 * Imperative map camera. The first usable GPS fix recenters the map once, unless the user already
 * moved it themselves.
 */
export function useMapCamera(cameraRef: RefObject<CameraRef | null>, position: LatLng | null, radiusM: number): MapCamera {
  const hasMoved = useRef(false);
  const hasCentered = useRef(false);
  const [initialRegion] = useState(() => regionAround(DEFAULT_CENTER, DEFAULT_RADIUS_M));
  const [region, setRegion] = useState<Region>(initialRegion);

  const fitRegion = (target: Region): void =>
    runCamera(() => cameraRef.current?.fitBounds(regionToBounds(target), { duration: MAP_ANIMATION_MS, easing: 'ease' }));

  useEffect(() => {
    if (!position || hasCentered.current || hasMoved.current) return;
    hasCentered.current = true;
    runCamera(() =>
      cameraRef.current?.fitBounds(regionToBounds(regionAround(position, radiusM)), { duration: MAP_ANIMATION_MS, easing: 'ease' }),
    );
  }, [cameraRef, position, radiusM]);

  return {
    initialRegion,
    region,
    setRegion,
    markMoved: () => {
      hasMoved.current = true;
    },
    animateTo: (center) => fitRegion(regionAround(center, radiusM)),
    zoomTo: fitRegion,
  };
}
