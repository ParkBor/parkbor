import { useEffect, useRef, useState, type RefObject } from 'react';
import type MapView from 'react-native-maps';

import type { LatLng, Region } from '@/features/map/geo';
import { DEFAULT_CENTER } from '@/features/map/locationModel';
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
export function useMapCamera(mapRef: RefObject<MapView | null>, position: LatLng | null, radiusM: number): MapCamera {
  const hasMoved = useRef(false);
  const hasCentered = useRef(false);
  const [initialRegion] = useState(() => regionAround(DEFAULT_CENTER, DEFAULT_RADIUS_M));
  const [region, setRegion] = useState<Region>(initialRegion);

  useEffect(() => {
    if (!position || hasCentered.current || hasMoved.current) return;
    hasCentered.current = true;
    mapRef.current?.animateToRegion(regionAround(position, radiusM), MAP_ANIMATION_MS);
  }, [mapRef, position, radiusM]);

  return {
    initialRegion,
    region,
    setRegion,
    markMoved: () => {
      hasMoved.current = true;
    },
    animateTo: (center) => mapRef.current?.animateToRegion(regionAround(center, radiusM), MAP_ANIMATION_MS),
    zoomTo: (target) => mapRef.current?.animateToRegion(target, MAP_ANIMATION_MS),
  };
}
