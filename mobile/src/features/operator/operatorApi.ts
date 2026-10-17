import type { AxiosInstance } from 'axios';

import {
  parseCheckIn,
  parseCheckOut,
  parseInviteAccepted,
  parseLotPage,
  parseSlotMap,
  parseSlotPatched,
  parseWalkIn,
  type CheckInResult,
  type CheckOutResult,
  type InviteAccepted,
  type OperatorLot,
  type SlotMap,
  type SlotPatched,
  type WalkInResult,
} from '@/features/operator/operatorSchemas';
import type { CheckoutTarget } from '@/features/operator/checkoutFlow';
import type { WalkInPayload } from '@/features/operator/walkInForm';
import { MAX_SCAN_LENGTH } from '@/features/operator/scanPolicy';
import { api } from '@/lib/api';
import { ContractError, isUuid } from '@/lib/contract';

export interface CheckInParams {
  token: string;
  lotId: string;
  /** Normalised plate to compare with the booking, or null. */
  plate: string | null;
}

export interface CheckOutParams {
  target: CheckoutTarget;
  lotId: string;
  collect: boolean;
}

export interface SlotStatusParams {
  slotId: string;
  status: 'FREE' | 'OUT_OF_SERVICE';
  force: boolean;
}

export interface OperatorApi {
  lots(signal?: AbortSignal): Promise<OperatorLot[]>;
  slots(lotId: string, signal?: AbortSignal): Promise<SlotMap>;
  checkIn(params: CheckInParams): Promise<CheckInResult>;
  checkOut(params: CheckOutParams): Promise<CheckOutResult>;
  walkIn(payload: WalkInPayload): Promise<WalkInResult>;
  setSlotStatus(params: SlotStatusParams): Promise<SlotPatched>;
  acceptInvite(code: string): Promise<InviteAccepted>;
}

type OperatorClient = Pick<AxiosInstance, 'get' | 'post' | 'patch'>;

const LOT_PAGE_SIZE = 50;
const MAX_LOT_PAGES = 5;

function assertId(id: string, what: string): void {
  if (!isUuid(id)) throw new ContractError(what);
}

function assertToken(token: string): void {
  if (token.length === 0 || token.length > MAX_SCAN_LENGTH) throw new RangeError('Invalid QR token length');
}

/**
 * Operator endpoints (ARCHITECTURE 9.2). Tokens, plates, booking ids and invite codes travel only in
 * JSON bodies - never in the URL or query string - and are never logged. Responses are parsed
 * strictly; ids are UUID-checked before they enter a URL path. The Idempotency-Key header is not
 * used: check-out `collect` repeats are safe on the server by contract.
 */
export function createOperatorApi(client: OperatorClient): OperatorApi {
  return {
    async lots(signal) {
      const lots: OperatorLot[] = [];
      for (let page = 1; page <= MAX_LOT_PAGES; page += 1) {
        // Pages are requested by number; the server's `next` URL is never followed.
        const response = await client.get<unknown>('/operator/parkings', { params: { page, page_size: LOT_PAGE_SIZE }, signal });
        const parsed = parseLotPage(response.data);
        lots.push(...parsed.results);
        if (!parsed.hasNext) break;
      }
      return lots;
    },

    async slots(lotId, signal) {
      assertId(lotId, 'parking id');
      const response = await client.get<unknown>(`/operator/parkings/${lotId}/slots`, { signal });
      return parseSlotMap(response.data);
    },

    async checkIn({ token, lotId, plate }) {
      assertToken(token);
      assertId(lotId, 'parking id');
      const response = await client.post<unknown>(
        '/operator/checkin',
        { qr_token: token, parking_lot_id: lotId, ...(plate ? { plate_number: plate } : {}) },
        {},
      );
      return parseCheckIn(response.data);
    },

    async checkOut({ target, lotId, collect }) {
      assertId(lotId, 'parking id');
      let body: Record<string, unknown>;
      if (target.kind === 'qr') {
        assertToken(target.token);
        body = { qr_token: target.token, parking_lot_id: lotId, collect, ...(target.plate ? { plate_number: target.plate } : {}) };
      } else {
        assertId(target.bookingId, 'booking id');
        body = {
          booking_id: target.bookingId,
          plate_number: target.plate,
          parking_lot_id: lotId,
          collect,
          ...(target.overrideNote ? { override: true, note: target.overrideNote } : {}),
        };
      }
      const response = await client.post<unknown>('/operator/checkout', body, {});
      return parseCheckOut(response.data);
    },

    async walkIn(payload) {
      assertId(payload.slotId, 'slot id');
      const response = await client.post<unknown>(
        '/operator/walk-in',
        { slot_id: payload.slotId, plate_number: payload.plateNumber, vehicle_type: payload.vehicleType },
        {},
      );
      return parseWalkIn(response.data);
    },

    async setSlotStatus({ slotId, status, force }) {
      assertId(slotId, 'slot id');
      const response = await client.patch<unknown>(`/operator/slots/${slotId}`, { status, force }, {});
      return parseSlotPatched(response.data);
    },

    async acceptInvite(code) {
      const response = await client.post<unknown>('/me/operator-invites/accept', { code }, {});
      return parseInviteAccepted(response.data);
    },
  };
}

export const operatorApi: OperatorApi = createOperatorApi(api);
