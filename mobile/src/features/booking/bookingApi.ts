import type { AxiosInstance, AxiosResponse } from 'axios';

import {
  parseBooking,
  parseBookingPage,
  parseCancelPreview,
  parseQr,
  type Booking,
  type BookingPage,
  type CancelPreview,
  type QrPayload,
} from '@/features/booking/bookingSchemas';
import { IDEMPOTENCY_KEY_PATTERN, type CreateBookingPayload } from '@/features/booking/idempotencyKey';
import { parseAvailability, parsePrice, type Availability, type Price } from '@/features/booking/quoteSchemas';
import { serverClock, type ClockSample } from '@/features/booking/serverClock';
import type { SlotType } from '@/features/map/schemas';
import { api } from '@/lib/api';
import { ContractError, isoInstant, isUuid } from '@/lib/contract';
import { buildQueryString } from '@/lib/queryEncoding';

export type BookingScope = 'active' | 'upcoming' | 'history';

export interface ListParams {
  scope?: BookingScope;
  status?: readonly string[];
  page: number;
  pageSize: number;
}

export interface QuoteParams {
  startMs: number;
  endMs: number;
  slotType: SlotType | null;
}

export interface CreateResult {
  booking: Booking;
  /** 200 + `Idempotent-Replayed: true`: the server returned the booking of an earlier identical request. */
  isReplay: boolean;
}

export interface BookingApi {
  create(payload: CreateBookingPayload, idempotencyKey: string, signal?: AbortSignal): Promise<CreateResult>;
  list(params: ListParams, signal?: AbortSignal): Promise<BookingPage>;
  get(id: string, signal?: AbortSignal): Promise<Booking>;
  cancel(id: string): Promise<Booking>;
  cancelPreview(id: string, signal?: AbortSignal): Promise<CancelPreview>;
  qr(id: string, signal?: AbortSignal): Promise<QrPayload>;
  availability(lotId: string, params: QuoteParams, signal?: AbortSignal): Promise<Availability>;
  price(lotId: string, params: QuoteParams & { slotType: SlotType }, signal?: AbortSignal): Promise<Price>;
}

type BookingClient = Pick<AxiosInstance, 'get' | 'post'>;

function assertId(id: string, what: string): void {
  if (!isUuid(id)) throw new ContractError(what);
}

function header(response: Pick<AxiosResponse, 'headers'>, name: string): string | undefined {
  const value: unknown = (response.headers as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Booking endpoints (ARCHITECTURE 9.5). Instants are sent as UTC `Z` (no "+" to encode) and the
 * query string is built by `buildQueryString`, which percent-encodes anyway. Responses are parsed
 * strictly; ids are UUID-checked before they enter a URL path. `observeServerDate` feeds the
 * response `Date` header to the server clock used by the countdowns.
 */
export function createBookingApi(
  client: BookingClient,
  observeServerDate: (sample: ClockSample) => void = (sample) => serverClock.observe(sample),
): BookingApi {
  const observe = (response: Pick<AxiosResponse, 'headers'>, sentAtMs: number): void =>
    observeServerDate({
      dateHeader: header(response, 'date'),
      ageHeader: header(response, 'age'),
      sentAtMs,
      receivedAtMs: Date.now(),
    });
  const serializer = { paramsSerializer: (params: Record<string, string | number | boolean | undefined>) => buildQueryString(params) };

  function quoteQuery(params: QuoteParams): Record<string, string> {
    return {
      from: isoInstant(params.startMs),
      to: isoInstant(params.endMs),
      ...(params.slotType ? { slot_type: params.slotType } : {}),
    };
  }

  return {
    async create(payload, idempotencyKey, signal) {
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) throw new RangeError('Invalid idempotency key');
      assertId(payload.parkingLotId, 'booking request');
      assertId(payload.vehicleId, 'booking request');
      const sentAtMs = Date.now();
      const response = await client.post<unknown>(
        '/bookings',
        {
          parking_lot_id: payload.parkingLotId,
          slot_type: payload.slotType,
          vehicle_id: payload.vehicleId,
          start: isoInstant(payload.startMs),
          end: isoInstant(payload.endMs),
          preferred_slot_id: payload.preferredSlotId,
          // Omitted = the server default; the Idempotency-Key fingerprint includes it either way.
          ...(payload.paymentProvider ? { payment_provider: payload.paymentProvider } : {}),
        },
        { headers: { 'Idempotency-Key': idempotencyKey }, signal },
      );
      observe(response, sentAtMs);
      return {
        booking: parseBooking(response.data),
        isReplay: response.status === 200 && header(response, 'idempotent-replayed') === 'true',
      };
    },

    async list(params, signal) {
      const query: Record<string, string | number> = {
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.status && params.status.length > 0 ? { status: params.status.join(',') } : {}),
        page: params.page,
        page_size: params.pageSize,
      };
      const sentAtMs = Date.now();
      const response = await client.get<unknown>('/bookings', { params: query, signal, ...serializer });
      observe(response, sentAtMs);
      return parseBookingPage(response.data);
    },

    async get(id, signal) {
      assertId(id, 'booking id');
      const sentAtMs = Date.now();
      const response = await client.get<unknown>(`/bookings/${id}`, { signal });
      observe(response, sentAtMs);
      return parseBooking(response.data);
    },

    async cancel(id) {
      assertId(id, 'booking id');
      const sentAtMs = Date.now();
      const response = await client.post<unknown>(`/bookings/${id}/cancel`, undefined, {});
      observe(response, sentAtMs);
      return parseBooking(response.data);
    },

    async cancelPreview(id, signal) {
      assertId(id, 'booking id');
      const response = await client.get<unknown>(`/bookings/${id}/cancel-preview`, { signal });
      return parseCancelPreview(response.data);
    },

    async qr(id, signal) {
      assertId(id, 'booking id');
      const response = await client.get<unknown>(`/bookings/${id}/qr`, { signal });
      return parseQr(response.data);
    },

    async availability(lotId, params, signal) {
      assertId(lotId, 'parking id');
      const response = await client.get<unknown>(`/parkings/${lotId}/availability`, {
        params: quoteQuery(params),
        signal,
        ...serializer,
      });
      return parseAvailability(response.data);
    },

    async price(lotId, params, signal) {
      assertId(lotId, 'parking id');
      const response = await client.get<unknown>(`/parkings/${lotId}/price`, {
        params: quoteQuery(params),
        signal,
        ...serializer,
      });
      return parsePrice(response.data);
    },
  };
}

export const bookingApi: BookingApi = createBookingApi(api);
