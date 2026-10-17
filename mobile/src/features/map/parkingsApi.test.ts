import { describe, expect, it, vi } from 'vitest';

import { createParkingsApi } from '@/features/map/parkingsApi';
import { InvalidResponseError } from '@/features/map/schemas';

// Importing parkingsApi pulls in the real auth client; replace it (vi.mock is hoisted).
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

const validBody = { results: [], radius_used_m: 3000, count: 0 };

const params = {
  lat: 41.2995,
  lng: 69.2401,
  radiusM: 3000,
  slotType: null,
  limit: 50,
  sort: 'recommended',
  onlyOpen: false,
} as const;

describe('parkingsApi.nearby', () => {
  it('calls the contract endpoint with snake_case query params', async () => {
    const get = vi.fn().mockResolvedValue({ data: validBody });
    const result = await createParkingsApi({ get }).nearby(params);
    expect(get).toHaveBeenCalledWith('/parkings/nearby', {
      params: { lat: 41.2995, lng: 69.2401, radius: 3000, limit: 50, sort: 'recommended', only_open: false },
      signal: undefined,
    });
    expect(result.radiusUsedM).toBe(3000);
  });

  it('adds slot_type only when a slot type is chosen and forwards the abort signal', async () => {
    const get = vi.fn().mockResolvedValue({ data: validBody });
    const controller = new AbortController();
    await createParkingsApi({ get }).nearby(
      { ...params, slotType: 'EV', onlyOpen: true, sort: 'cheapest' },
      controller.signal,
    );
    expect(get).toHaveBeenCalledWith('/parkings/nearby', {
      params: expect.objectContaining({ slot_type: 'EV', only_open: true, sort: 'cheapest' }),
      signal: controller.signal,
    });
  });

  it('rejects a malformed body with InvalidResponseError', async () => {
    const get = vi.fn().mockResolvedValue({ data: { nope: true } });
    await expect(createParkingsApi({ get }).nearby(params)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('propagates transport errors unchanged', async () => {
    const failure = new Error('boom');
    const get = vi.fn().mockRejectedValue(failure);
    await expect(createParkingsApi({ get }).nearby(params)).rejects.toBe(failure);
  });
});
