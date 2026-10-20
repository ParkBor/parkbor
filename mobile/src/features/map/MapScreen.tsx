import type BottomSheet from '@gorhom/bottom-sheet';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';

import { AppMap } from '@/features/map/AppMap';
import { activeFilterCount } from '@/features/map/filters';
import { useFiltersStore } from '@/features/map/filtersStore';
import { FiltersSheet } from '@/features/map/FiltersSheet';
import type { LatLng, Region } from '@/features/map/geo';
import { DEFAULT_CENTER } from '@/features/map/locationModel';
import { createPressGuard } from '@/features/map/pressGuard';
import { boundsOfPath, runCamera } from '@/features/map/maplibreAdapter';
import { MapControls } from '@/features/map/MapControls';
import { MapSheet, SHEET_DEFAULT_INDEX } from '@/features/map/MapSheet';
import { ParkingMarkers } from '@/features/map/ParkingMarkers';
import type { Parking } from '@/features/map/schemas';
import { useMapCamera } from '@/features/map/useMapCamera';
import { useNearbyParkings } from '@/features/map/useNearbyParkings';
import { useUserLocation } from '@/features/map/UserLocation';
import { formatCoordParam } from '@/features/route/lotParams';
import { RouteLayer } from '@/features/route/RouteLayer';
import { useRoute } from '@/features/route/useRoute';
import { usePalette } from '@/theme/theme';

/** Main tab: map with clustered lots, floating controls and a pull-up list / preview sheet. */
export function MapScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const filters = useFiltersStore((s) => s.filters);
  const location = useUserLocation();
  const nearby = useNearbyParkings(location.position, filters, location.isReady);
  const cameraRef = useRef<CameraRef>(null);
  const camera = useMapCamera(cameraRef, location.position, filters.radiusM);
  const sheetRef = useRef<BottomSheet>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const router = useRouter();
  // The route origin is frozen when "Route" is pressed, so GPS drift does not refetch it.
  const [routeRequest, setRouteRequest] = useState<{ parkingId: string; from: LatLng } | null>(null);
  const selected = nearby.parkings.find((parking) => parking.id === selectedId) ?? null;

  const activeRoute = selected !== null && routeRequest?.parkingId === selected.id ? routeRequest : null;
  const routeState = useRoute(activeRoute?.from ?? null, activeRoute ? (selected?.location ?? null) : null);
  const routePath = routeState.route?.path;
  useEffect(() => {
    const bounds = routePath ? boundsOfPath(routePath) : null;
    if (bounds) runCamera(() => cameraRef.current?.fitBounds(bounds, { padding: ROUTE_FIT_PADDING, duration: ROUTE_FIT_MS, easing: 'ease' }));
  }, [routePath]);

  // A marker tap must not be undone by the map-level tap that can follow it.
  const [pressGuard] = useState(() => createPressGuard(() => Date.now()));
  const select = (parking: Parking): void => {
    pressGuard.markTapped();
    setSelectedId(parking.id);
    sheetRef.current?.snapToIndex(SHEET_DEFAULT_INDEX);
  };
  const backToUser = (): void => {
    nearby.backToUser();
    camera.animateTo(location.position ?? DEFAULT_CENTER);
    if (!location.position && location.state === 'denied') void location.requestAccess();
  };
  const regionSettled = (next: Region): void => {
    camera.setRegion(next);
    nearby.onRegionChangeComplete(next);
  };
  const showRoute = (parking: Parking): void => {
    if (!location.position) {
      Alert.alert(t('route.needLocation'), undefined, [{ text: t('map.ok') }]);
      if (location.state === 'denied') void location.requestAccess();
      return;
    }
    setRouteRequest({ parkingId: parking.id, from: location.position });
  };
  const startNavigation = (parking: Parking): void => {
    // Coordinates travel in the in-app link only so the screen works without the nearby cache.
    const from = location.position;
    router.push({
      pathname: '/navigate/[parkingId]',
      params: {
        parkingId: parking.id,
        lat: formatCoordParam(parking.location.lat),
        lng: formatCoordParam(parking.location.lng),
        name: parking.name,
        ...(from ? { fromLat: formatCoordParam(from.lat), fromLng: formatCoordParam(from.lng) } : {}),
      },
    });
  };
  const openDetails = (parking: Parking): void =>
    router.push({ pathname: '/parking/[id]', params: { id: parking.id } });

  return (
    <View testID="map-screen" style={[styles.root, { backgroundColor: p.background }]}>
      <AppMap
        cameraRef={cameraRef}
        initialRegion={camera.initialRegion}
        showsUserLocation={location.state === 'granted'}
        showCredit={false}
        onUserMove={camera.markMoved}
        onPress={() => {
          if (pressGuard.shouldHandleMapPress()) setSelectedId(null);
        }}
        onRegionSettled={regionSettled}
      >
        <ParkingMarkers
          parkings={nearby.parkings}
          region={camera.region}
          selectedId={selected?.id ?? null}
          onSelect={select}
          onZoomTo={(region) => {
            pressGuard.markTapped();
            camera.zoomTo(region);
          }}
        />
        {activeRoute && routeState.route ? <RouteLayer route={routeState.route} /> : null}
      </AppMap>
      <MapControls
        locationState={location.state}
        filterCount={activeFilterCount(filters)}
        showSearchHere={nearby.showSearchHere}
        isRefreshing={nearby.isFetching && nearby.parkings.length > 0}
        onRequestAccess={() => void location.requestAccess()}
        onOpenSettings={location.openSettings}
        onOpenFilters={() => setIsFiltersOpen(true)}
        onBackToUser={backToUser}
        onSearchHere={nearby.searchHere}
      />
      <MapSheet
        sheetRef={sheetRef}
        nearby={nearby}
        selected={selected}
        onSelect={select}
        onClosePreview={() => {
          setSelectedId(null);
          setRouteRequest(null);
        }}
        onRoute={showRoute}
        onStart={startNavigation}
        onDetails={openDetails}
        onBook={(parking) => router.push({ pathname: '/booking/new', params: { lotId: parking.id } })}
        routeState={activeRoute ? routeState : null}
        onClearRoute={() => setRouteRequest(null)}
        onOpenFilters={() => setIsFiltersOpen(true)}
      />
      <FiltersSheet visible={isFiltersOpen} onClose={() => setIsFiltersOpen(false)} />
    </View>
  );
}

const ROUTE_FIT_PADDING = { top: 80, right: 40, bottom: 320, left: 40 };
const ROUTE_FIT_MS = 500;

const styles = StyleSheet.create({ root: { flex: 1 } });
