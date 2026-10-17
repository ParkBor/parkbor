import type BottomSheet from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform, StyleSheet, useColorScheme, View } from 'react-native';
import MapView, { PROVIDER_GOOGLE } from 'react-native-maps';

import { DARK_MAP_STYLE } from '@/features/map/darkMapStyle';
import { activeFilterCount } from '@/features/map/filters';
import { useFiltersStore } from '@/features/map/filtersStore';
import { FiltersSheet } from '@/features/map/FiltersSheet';
import type { LatLng, Region } from '@/features/map/geo';
import { DEFAULT_CENTER } from '@/features/map/locationModel';
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
  const isDark = useColorScheme() === 'dark';
  const filters = useFiltersStore((s) => s.filters);
  const location = useUserLocation();
  const nearby = useNearbyParkings(location.position, filters, location.isReady);
  const mapRef = useRef<MapView>(null);
  const camera = useMapCamera(mapRef, location.position, filters.radiusM);
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
    if (routePath) mapRef.current?.fitToCoordinates(routePath, { edgePadding: ROUTE_FIT_PADDING, animated: true });
  }, [routePath]);

  const select = (parking: Parking): void => {
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
    <View style={[styles.root, { backgroundColor: p.background }]}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={camera.initialRegion}
        userInterfaceStyle={isDark ? 'dark' : 'light'}
        customMapStyle={isDark ? DARK_MAP_STYLE : undefined}
        showsUserLocation={location.state === 'granted'}
        showsMyLocationButton={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        onPanDrag={camera.markMoved}
        onPress={() => setSelectedId(null)}
        onRegionChangeComplete={regionSettled}
      >
        <ParkingMarkers
          parkings={nearby.parkings}
          region={camera.region}
          selectedId={selected?.id ?? null}
          onSelect={select}
          onZoomTo={camera.zoomTo}
        />
        {activeRoute && routeState.route ? <RouteLayer route={routeState.route} /> : null}
      </MapView>
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
        routeState={activeRoute ? routeState : null}
        onClearRoute={() => setRouteRequest(null)}
        onOpenFilters={() => setIsFiltersOpen(true)}
      />
      <FiltersSheet visible={isFiltersOpen} onClose={() => setIsFiltersOpen(false)} />
    </View>
  );
}

const ROUTE_FIT_PADDING = { top: 80, right: 40, bottom: 320, left: 40 };

const styles = StyleSheet.create({ root: { flex: 1 } });
