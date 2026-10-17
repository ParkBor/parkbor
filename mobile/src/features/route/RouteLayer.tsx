import { Polyline } from 'react-native-maps';

import type { Route } from '@/features/route/routeSchemas';
import { usePalette } from '@/theme/theme';

const ROUTE_WIDTH = 6;
const DASH = [14, 10];

interface RouteLayerProps {
  route: Route;
}

/**
 * The route line. A real road route is solid; an approximate (straight-line) one is dashed and
 * amber so it cannot be mistaken for a drivable road.
 */
export function RouteLayer({ route }: RouteLayerProps) {
  const p = usePalette();
  return (
    <Polyline
      coordinates={route.path}
      strokeWidth={ROUTE_WIDTH}
      strokeColor={route.isApproximate ? p.warningText : p.primary}
      lineDashPattern={route.isApproximate ? DASH : undefined}
      lineCap="round"
      lineJoin="round"
      zIndex={2}
    />
  );
}
