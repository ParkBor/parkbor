import Supercluster from 'supercluster';

import type { LatLng, Region } from '@/features/map/geo';
import { markerColor, type MarkerKind } from '@/features/map/markerColor';
import type { Parking } from '@/features/map/schemas';

// Own clustering on top of supercluster (instead of react-native-map-clustering): the cluster
// color/number must aggregate free slots of OPEN lots, which that wrapper cannot do.

const CLUSTER_RADIUS_PX = 60;
const CLUSTER_MAX_ZOOM = 16;
const MIN_ZOOM = 0;
const MAX_ZOOM = 20;
const VIEWPORT_PADDING = 0.2;
const MAX_LATITUDE = 85;
/** Phone viewport is taller than wide. */
const EXPANSION_ASPECT = 1.6;
/** Slightly zoomed-in past the split level so members are clearly apart. */
const EXPANSION_MARGIN = 0.99;

interface PointProps {
  parkingId: string;
  free: number;
  total: number;
  open: number;
}

interface ClusterProps {
  free: number;
  total: number;
  open: number;
}

export interface ClusterIndex {
  engine: Supercluster<PointProps, ClusterProps>;
  byId: ReadonlyMap<string, Parking>;
}

export interface ParkingItem {
  type: 'parking';
  parking: Parking;
}

export interface ClusterItem {
  type: 'cluster';
  id: number;
  lat: number;
  lng: number;
  /** Number of lots inside. */
  count: number;
  /** Free slots summed over OPEN lots only. */
  free: number;
  total: number;
  kind: MarkerKind;
}

export type MapItem = ParkingItem | ClusterItem;

export function buildClusterIndex(parkings: readonly Parking[]): ClusterIndex {
  const engine = new Supercluster<PointProps, ClusterProps>({
    radius: CLUSTER_RADIUS_PX,
    maxZoom: CLUSTER_MAX_ZOOM,
    minPoints: 2,
    map: (p) => ({ free: p.open ? p.free : 0, total: p.open ? p.total : 0, open: p.open }),
    reduce: (acc, p) => {
      acc.free += p.free;
      acc.total += p.total;
      acc.open += p.open;
    },
  });
  engine.load(
    parkings.map((p) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.location.lng, p.location.lat] },
      properties: {
        parkingId: p.id,
        free: p.freeSlots,
        total: p.totalSlots,
        open: p.isOpen ? 1 : 0,
      },
    })),
  );
  return { engine, byId: new Map(parkings.map((p) => [p.id, p])) };
}

export function regionToZoom(longitudeDelta: number): number {
  if (!(longitudeDelta > 0)) return MAX_ZOOM;
  const zoom = Math.floor(Math.log2(360 / longitudeDelta));
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clusters and lots inside the (slightly padded) viewport. */
export function getMapItems(index: ClusterIndex, region: Region): MapItem[] {
  const halfLat = (region.latitudeDelta / 2) * (1 + VIEWPORT_PADDING);
  const halfLng = (region.longitudeDelta / 2) * (1 + VIEWPORT_PADDING);
  const features = index.engine.getClusters(
    [
      clamp(region.longitude - halfLng, -180, 180),
      clamp(region.latitude - halfLat, -MAX_LATITUDE, MAX_LATITUDE),
      clamp(region.longitude + halfLng, -180, 180),
      clamp(region.latitude + halfLat, -MAX_LATITUDE, MAX_LATITUDE),
    ],
    regionToZoom(region.longitudeDelta),
  );

  const items: MapItem[] = [];
  for (const feature of features) {
    const props = feature.properties;
    const [lng = 0, lat = 0] = feature.geometry.coordinates;
    if ('cluster' in props && props.cluster) {
      items.push({
        type: 'cluster',
        id: props.cluster_id,
        lat,
        lng,
        count: props.point_count,
        free: props.free,
        total: props.total,
        kind: props.open === 0 ? 'gray' : markerColor(props.free, props.total, true),
      });
      continue;
    }
    const parking = index.byId.get((props as PointProps).parkingId);
    if (parking) items.push({ type: 'parking', parking });
  }
  return items;
}

/** Region that is zoomed in just enough for the cluster to split into its members. */
export function clusterExpansionRegion(index: ClusterIndex, clusterId: number, center: LatLng | Pick<Region, 'latitude' | 'longitude'>): Region {
  const zoom = clamp(index.engine.getClusterExpansionZoom(clusterId), MIN_ZOOM, MAX_ZOOM);
  const longitudeDelta = (360 / 2 ** zoom) * EXPANSION_MARGIN;
  return {
    latitude: 'latitude' in center ? center.latitude : center.lat,
    longitude: 'longitude' in center ? center.longitude : center.lng,
    latitudeDelta: longitudeDelta * EXPANSION_ASPECT,
    longitudeDelta,
  };
}
