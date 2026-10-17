export interface LatLngValue {
  lat: number
  lng: number
}

const COORD_DECIMALS = 6

/** Round to ~0.1 m; Leaflet can return longitudes outside [-180, 180] after world wrap. */
export function normalizeLatLng(point: LatLngValue): LatLngValue {
  const lng = ((((point.lng + 180) % 360) + 360) % 360) - 180
  const round = (n: number) => Number(n.toFixed(COORD_DECIMALS))
  return { lat: round(Math.max(-90, Math.min(90, point.lat))), lng: round(lng) }
}
