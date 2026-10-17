import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const setView = vi.fn()
const tileProps: { url?: string; attribution?: string; maxZoom?: number } = {}

vi.mock('leaflet', () => ({ default: { Icon: { Default: { mergeOptions: () => undefined } } } }))
vi.mock('leaflet/dist/leaflet.css', () => ({}))
vi.mock('leaflet/dist/images/marker-icon-2x.png', () => ({ default: '' }))
vi.mock('leaflet/dist/images/marker-icon.png', () => ({ default: '' }))
vi.mock('leaflet/dist/images/marker-shadow.png', () => ({ default: '' }))
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TileLayer: (props: typeof tileProps) => {
    Object.assign(tileProps, props)
    return null
  },
  Marker: () => null,
  useMapEvents: () => null,
  useMap: () => ({ setView, getZoom: () => 14 }),
}))

const { MapPicker } = await import('./MapPicker')

describe('MapPicker view', () => {
  it('recenters when the value changes from the lat/lng inputs', () => {
    const { rerender } = render(<MapPicker value={{ lat: 41, lng: 69 }} onChange={vi.fn()} />)
    setView.mockClear()
    rerender(<MapPicker value={{ lat: 42, lng: 70 }} onChange={vi.fn()} />)
    expect(setView).toHaveBeenCalledWith([42, 70], 14)
  })

  it('does not recenter when the value is unchanged', () => {
    const { rerender } = render(<MapPicker value={{ lat: 41, lng: 69 }} onChange={vi.fn()} />)
    setView.mockClear()
    rerender(<MapPicker value={{ lat: 41, lng: 69 }} onChange={vi.fn()} />)
    expect(setView).not.toHaveBeenCalled()
  })

  it('credits OpenStreetMap with a link and caps the zoom', () => {
    render(<MapPicker onChange={vi.fn()} />)
    expect(tileProps.attribution).toContain('href="https://www.openstreetmap.org/copyright"')
    expect(tileProps.maxZoom).toBe(19)
    expect(tileProps.url).toMatch(/^https:\/\/.*\{z\}\/\{x\}\/\{y\}/)
  })
})
