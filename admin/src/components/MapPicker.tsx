import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import { useEffect, useRef } from 'react'
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { normalizeLatLng, type LatLngValue } from '../lib/geo'

// Bundlers break Leaflet's default icon URL detection; point it at the bundled assets.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

// The public OSM tile server is for light use only; production deployments should set
// VITE_TILE_URL to their own tile provider.
const TILE_URL = import.meta.env.VITE_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const MAX_ZOOM = 19
const POINT_ZOOM = 15
const DEFAULT_ZOOM = 12
const TASHKENT: LatLngValue = { lat: 41.3111, lng: 69.2797 }

interface MapPickerProps {
  value?: LatLngValue | null
  onChange: (value: LatLngValue) => void
  /** Initial map centre when no point is chosen yet (Tashkent). */
  defaultCenter?: LatLngValue
}

function ClickHandler({ onChange }: { onChange: (value: LatLngValue) => void }) {
  useMapEvents({
    click(event) {
      onChange(normalizeLatLng({ lat: event.latlng.lat, lng: event.latlng.lng }))
    },
  })
  return null
}

/** Moves the view when the value changes from outside the map (typed lat/lng inputs). */
function Recenter({ value }: { value: LatLngValue | null | undefined }) {
  const map = useMap()
  const last = useRef(value)
  useEffect(() => {
    const previous = last.current
    last.current = value
    if (!value || (previous && previous.lat === value.lat && previous.lng === value.lng)) return
    map.setView([value.lat, value.lng], map.getZoom())
  }, [map, value?.lat, value?.lng]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

export function MapPicker({ value, onChange, defaultCenter = TASHKENT }: MapPickerProps) {
  const center = value ?? defaultCenter
  return (
    <MapContainer
      center={[center.lat, center.lng]}
      zoom={value ? POINT_ZOOM : DEFAULT_ZOOM}
      style={{ height: 320, width: '100%' }}
      data-testid="map-picker"
    >
      <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} maxZoom={MAX_ZOOM} />
      <ClickHandler onChange={onChange} />
      <Recenter value={value} />
      {value ? <Marker position={[value.lat, value.lng]} /> : null}
    </MapContainer>
  )
}
