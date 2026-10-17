// Query keys. The cache is in memory only (never persisted) and cleared on logout / account switch.
export const bookingKeys = {
  all: ['bookings'] as const,
  list: (scope: string) => ['bookings', 'list', scope] as const,
  detail: (id: string) => ['bookings', 'detail', id] as const,
  qr: (id: string) => ['bookings', 'qr', id] as const,
  cancelPreview: (id: string) => ['bookings', 'cancel-preview', id] as const,
};

export const vehicleKeys = {
  all: ['vehicles'] as const,
};

export const quoteKeys = {
  availability: (lotId: string, slotType: string | null, startMs: number, endMs: number) =>
    ['parkings', lotId, 'availability', slotType, startMs, endMs] as const,
  price: (lotId: string, slotType: string, startMs: number, endMs: number) =>
    ['parkings', lotId, 'price', slotType, startMs, endMs] as const,
  lot: (lotId: string) => ['parkings', lotId] as const,
};
