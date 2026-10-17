import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

type ClickHandler = (event: { latlng: { lat: number; lng: number } }) => void
const captured: { click?: ClickHandler } = {}

vi.mock('leaflet', () => ({
  default: { Icon: { Default: { mergeOptions: () => undefined } } },
}))
vi.mock('leaflet/dist/leaflet.css', () => ({}))
vi.mock('leaflet/dist/images/marker-icon-2x.png', () => ({ default: '' }))
vi.mock('leaflet/dist/images/marker-icon.png', () => ({ default: '' }))
vi.mock('leaflet/dist/images/marker-shadow.png', () => ({ default: '' }))
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="map">{children}</div>
  ),
  TileLayer: () => null,
  Marker: ({ position }: { position: [number, number] }) => (
    <span data-testid="marker">{position.join(',')}</span>
  ),
  useMap: () => ({ setView: () => undefined, getZoom: () => 14 }),
  useMapEvents: (handlers: { click: ClickHandler }) => {
    captured.click = handlers.click
    return null
  },
}))

const { MapPicker } = await import('./MapPicker')
const { normalizeLatLng } = await import('../lib/geo')

describe('MapPicker', () => {
  it('reports the clicked point as lat/lng', () => {
    const onChange = vi.fn()
    render(<MapPicker onChange={onChange} />)
    if (!captured.click) throw new Error('click handler was not registered')
    captured.click({ latlng: { lat: 41.2755123456, lng: 69.2034 } })
    expect(onChange).toHaveBeenCalledWith({ lat: 41.275512, lng: 69.2034 })
  })

  it('shows a marker only when a value is set', () => {
    const { rerender } = render(<MapPicker onChange={vi.fn()} />)
    expect(screen.queryByTestId('marker')).not.toBeInTheDocument()
    rerender(<MapPicker value={{ lat: 41, lng: 69 }} onChange={vi.fn()} />)
    expect(screen.getByTestId('marker')).toHaveTextContent('41,69')
  })
})

describe('normalizeLatLng', () => {
  it('wraps longitudes from a world-wrapped map into [-180, 180]', () => {
    expect(normalizeLatLng({ lat: 10, lng: 190 }).lng).toBe(-170)
    expect(normalizeLatLng({ lat: 10, lng: -190 }).lng).toBe(170)
    expect(normalizeLatLng({ lat: 10, lng: 69.5 }).lng).toBe(69.5)
  })

  it('clamps latitude', () => {
    expect(normalizeLatLng({ lat: 95, lng: 0 }).lat).toBe(90)
    expect(normalizeLatLng({ lat: -95, lng: 0 }).lat).toBe(-90)
  })
})
