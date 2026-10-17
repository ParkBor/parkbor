import { describe, expect, it, vi } from 'vitest';

import { ContractError } from '@/lib/contract';
import { createVehiclesApi } from '@/features/vehicles/vehiclesApi';

// Importing the module pulls in the real auth client; replace it (vi.mock is hoisted).
vi.mock('@/lib/api', () => ({ api: {} }));

const ID = 'a91c1de0-1111-4222-8333-444455556666';
const raw = { id: ID, plate_number: '01A123BC', type: 'CAR', created_at: '2026-10-15T13:10:00+05:00' };

function client() {
  return {
    get: vi.fn().mockResolvedValue({ data: [raw] }),
    post: vi.fn().mockResolvedValue({ data: raw }),
    put: vi.fn().mockResolvedValue({ data: raw }),
    delete: vi.fn().mockResolvedValue({ data: undefined }),
  };
}

describe('vehiclesApi', () => {
  it('lists (unpaginated array)', async () => {
    const c = client();
    const list = await createVehiclesApi(c).list();
    expect(c.get).toHaveBeenCalledWith('/vehicles', { signal: undefined });
    expect(list).toEqual([{ id: ID, plateNumber: '01A123BC', type: 'CAR' }]);
  });

  it('creates with the snake_case body', async () => {
    const c = client();
    await createVehiclesApi(c).create({ plate: '01A123BC', type: 'EV' });
    expect(c.post).toHaveBeenCalledWith('/vehicles', { plate_number: '01A123BC', type: 'EV' });
  });

  it('updates with PUT and always sends the type', async () => {
    const c = client();
    const updated = await createVehiclesApi(c).update(ID, { plate: '01A123BC', type: 'TRUCK' });
    expect(c.put).toHaveBeenCalledWith(`/vehicles/${ID}`, { plate_number: '01A123BC', type: 'TRUCK' });
    expect(updated.id).toBe(ID);
  });

  it('removes by id', async () => {
    const c = client();
    await createVehiclesApi(c).remove(ID);
    expect(c.delete).toHaveBeenCalledWith(`/vehicles/${ID}`);
  });

  it('refuses ids that are not UUIDs', async () => {
    const c = client();
    const api = createVehiclesApi(c);
    await expect(api.update('../me', { plate: '01A123BC', type: 'CAR' })).rejects.toBeInstanceOf(ContractError);
    await expect(api.remove('1/2')).rejects.toBeInstanceOf(ContractError);
    expect(c.put).not.toHaveBeenCalled();
    expect(c.delete).not.toHaveBeenCalled();
  });

  it('rejects a broken response', async () => {
    const c = client();
    c.post.mockResolvedValue({ data: { nope: 1 } });
    await expect(createVehiclesApi(c).create({ plate: '01A123BC', type: 'CAR' })).rejects.toBeInstanceOf(ContractError);
  });
});
