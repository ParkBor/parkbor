import type { HttpClient } from './http'

export type LotStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'SUSPENDED'
export type SlotType = 'STANDARD' | 'EV' | 'DISABLED' | 'LARGE'
export type SlotStatus = 'FREE' | 'RESERVED' | 'OCCUPIED' | 'OUT_OF_SERVICE'

export interface Paginated<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}

export interface PageParams {
  page?: number
  page_size?: number
  search?: string
  ordering?: string
}

export interface LatLng {
  lat: number
  lng: number
}

export interface ParkingLot {
  id: string
  owner: string
  name: string
  address: string
  location: LatLng
  area: [number, number][] | null
  status: LotStatus
  open_time: string | null
  close_time: string | null
  total_slots: number
  free_slots: number
  rating: number
  created_at: string
}

export interface ParkingLotInput {
  owner?: string
  name: string
  address: string
  location: LatLng
  open_time?: string | null
  close_time?: string | null
}

export interface Zone {
  id: string
  parking_lot: string
  name: string
  floor: number
  created_at: string
}

export interface ZoneInput {
  parking_lot: string
  name: string
  floor: number
}

export interface Slot {
  id: string
  zone: string
  code: string
  type: SlotType
  status: SlotStatus
  distance_to_entrance: number
  created_at: string
}

export interface BulkSlotsInput {
  zone: string
  prefix: string
  start: number
  end: number
  type: SlotType
  distance_to_entrance: number
}

export interface BulkSlotsResult {
  created: number
  codes: string[]
}

export interface Tariff {
  id: string
  parking_lot: string
  slot_type: SlotType
  /** Decimal serialized as a string ("12000.00"); never convert to float for money maths. */
  price_per_hour: string
  rules: Record<string, unknown>
  created_at: string
}

export interface TariffInput {
  parking_lot: string
  slot_type: SlotType
  price_per_hour: string
  rules?: Record<string, unknown>
}

export interface ParkingListParams extends PageParams {
  status?: LotStatus
}

export interface SlotListParams extends PageParams {
  zone?: string
  parking_lot?: string
  type?: SlotType
  status?: SlotStatus
}

/** Percent-encode an id for use as ONE path segment ('.'/'..' would still traverse). */
function seg(id: string): string {
  if (!id || id === '.' || id === '..') throw new TypeError('Invalid resource id')
  return encodeURIComponent(id)
}

export function createAdminApi(http: HttpClient) {
  const base = '/admin'
  return {
    parkings: {
      list: (params: ParkingListParams = {}) =>
        http.request<Paginated<ParkingLot>>('GET', `${base}/parkings`, { query: { ...params } }),
      get: (id: string) => http.request<ParkingLot>('GET', `${base}/parkings/${seg(id)}`),
      create: (body: ParkingLotInput) =>
        http.request<ParkingLot>('POST', `${base}/parkings`, { body }),
      update: (id: string, body: Partial<ParkingLotInput>) =>
        http.request<ParkingLot>('PATCH', `${base}/parkings/${seg(id)}`, { body }),
      remove: (id: string) => http.request<null>('DELETE', `${base}/parkings/${seg(id)}`),
      approve: (id: string) => http.request<ParkingLot>('POST', `${base}/parkings/${seg(id)}/approve`),
      suspend: (id: string) => http.request<ParkingLot>('POST', `${base}/parkings/${seg(id)}/suspend`),
      restore: (id: string) => http.request<ParkingLot>('POST', `${base}/parkings/${seg(id)}/restore`),
    },
    zones: {
      list: (params: PageParams & { parking_lot?: string } = {}) =>
        http.request<Paginated<Zone>>('GET', `${base}/zones`, { query: { ...params } }),
      create: (body: ZoneInput) => http.request<Zone>('POST', `${base}/zones`, { body }),
      remove: (id: string) => http.request<null>('DELETE', `${base}/zones/${seg(id)}`),
    },
    slots: {
      list: (params: SlotListParams = {}) =>
        http.request<Paginated<Slot>>('GET', `${base}/slots`, { query: { ...params } }),
      bulk: (body: BulkSlotsInput) =>
        http.request<BulkSlotsResult>('POST', `${base}/slots/bulk`, { body }),
      remove: (id: string) => http.request<null>('DELETE', `${base}/slots/${seg(id)}`),
    },
    tariffs: {
      list: (params: PageParams & { parking_lot?: string } = {}) =>
        http.request<Paginated<Tariff>>('GET', `${base}/tariffs`, { query: { ...params } }),
      create: (body: TariffInput) => http.request<Tariff>('POST', `${base}/tariffs`, { body }),
      update: (id: string, body: Partial<TariffInput>) =>
        http.request<Tariff>('PATCH', `${base}/tariffs/${seg(id)}`, { body }),
      remove: (id: string) => http.request<null>('DELETE', `${base}/tariffs/${seg(id)}`),
    },
  }
}

export type AdminApi = ReturnType<typeof createAdminApi>
