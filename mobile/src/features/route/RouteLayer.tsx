import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';

import { pathToLineFeature } from '@/features/map/maplibreAdapter';
import type { Route } from '@/features/route/routeSchemas';
import { usePalette } from '@/theme/theme';

const ROUTE_WIDTH = 6;
/** MapLibre dash arrays are in multiples of the line width. */
const DASH = [2, 1.5];

interface RouteLayerProps {
  route: Route;
}

/**
 * The route line. A real road route is solid; an approximate (straight-line) one is dashed and
 * amber so it cannot be mistaken for a drivable road.
 */
export function RouteLayer({ route }: RouteLayerProps) {
  const p = usePalette();
  const feature = useMemo(() => pathToLineFeature(route.path), [route.path]);
  if (!feature) return null;
  return (
    <GeoJSONSource id="route" data={feature}>
      <Layer
        id="route-line"
        type="line"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{
          'line-color': route.isApproximate ? p.warningText : p.primary,
          'line-width': ROUTE_WIDTH,
          ...(route.isApproximate ? { 'line-dasharray': DASH } : {}),
        }}
      />
    </GeoJSONSource>
  );
}
