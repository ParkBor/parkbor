import { describe, expect, it } from 'vitest';

import { InvalidResponseError, parseNearbyResponse } from '@/features/map/schemas';

const item = {
  id: 'b2f1',
  name: 'Chorsu Parking',
  address: 'Chorsu, Tashkent',
  location: { lat: 41.3265, lng: 69.2285 },
  distance_m: 350,
  duration_s: 120,
  free_slots: 12,
  total_slots: 50,
  price_per_hour: '5000.00',
  rating: 4.6,
  is_open: true,
  score: 0.82,
};

const body = (over: Record<string, unknown> = {}) => ({
  results: [item],
  radius_used_m: 3000,
  count: 1,
  ...over,
});

describe('parseNearbyResponse', () => {
  it('maps a valid response to camelCase domain objects', () => {
    const parsed = parseNearbyResponse(body());
    expect(parsed.radiusUsedM).toBe(3000);
    expect(parsed.count).toBe(1);
    expect(parsed.skippedCount).toBe(0);
    expect(parsed.results[0]).toEqual({
      id: 'b2f1',
      name: 'Chorsu Parking',
      address: 'Chorsu, Tashkent',
      location: { lat: 41.3265, lng: 69.2285 },
      distanceM: 350,
      durationS: 120,
      freeSlots: 12,
      totalSlots: 50,
      pricePerHour: '5000.00',
      rating: 4.6,
      isOpen: true,
      score: 0.82,
    });
  });

  it('accepts null duration, price, rating and score', () => {
    const parsed = parseNearbyResponse(
      body({ results: [{ ...item, duration_s: null, price_per_hour: null, rating: null, score: null }] }),
    );
    expect(parsed.results[0]).toMatchObject({
      durationS: null,
      pricePerHour: null,
      rating: null,
      score: null,
    });
  });

  it('accepts an empty result list', () => {
    expect(parseNearbyResponse(body({ results: [], count: 0 })).results).toEqual([]);
  });

  it('turns a numeric id into a string and ignores unknown fields', () => {
    const parsed = parseNearbyResponse(body({ results: [{ ...item, id: 7, extra: 'x' }] }));
    expect(parsed.results[0]?.id).toBe('7');
    expect(parsed.results[0]).not.toHaveProperty('extra');
  });

  it.each([
    ['not an object', null],
    ['results missing', { radius_used_m: 3000, count: 0 }],
    ['results not an array', body({ results: 'x' })],
    ['radius missing', { results: [], count: 0 }],
    ['count missing', { results: [], radius_used_m: 3000 }],
    ['count negative', body({ count: -1 })],
    ['every item invalid', body({ results: [{ ...item, free_slots: -1 }, { nope: 1 }] })],
  ])('rejects the whole response: %s', (_label, data) => {
    expect(() => parseNearbyResponse(data)).toThrow(InvalidResponseError);
  });

  it.each([
    ['name missing', { ...item, name: undefined }],
    ['latitude out of range', { ...item, location: { lat: 91, lng: 0 } }],
    ['longitude out of range', { ...item, location: { lat: 0, lng: 181 } }],
    ['location as string', { ...item, location: '41,69' }],
    ['negative free slots', { ...item, free_slots: -1 }],
    ['fractional free slots', { ...item, free_slots: 1.5 }],
    ['price not decimal', { ...item, price_per_hour: 'abc' }],
    ['negative price', { ...item, price_per_hour: '-5.00' }],
    ['is_open as string', { ...item, is_open: 'true' }],
    ['negative distance', { ...item, distance_m: -1 }],
    ['rating as string', { ...item, rating: '4.6' }],
    ['not an object', 'garbage'],
  ])('drops only the invalid item: %s', (_label, bad) => {
    const good = { ...item, id: 'good' };
    const parsed = parseNearbyResponse(body({ results: [bad, good], count: 2 }));
    expect(parsed.results.map((r) => r.id)).toEqual(['good']);
    expect(parsed.skippedCount).toBe(1);
  });

  it('reports zero skipped items for a clean response', () => {
    expect(parseNearbyResponse(body()).skippedCount).toBe(0);
  });

  // Backend: DRF DecimalField with the default COERCE_DECIMAL_TO_STRING=True (config/settings/base.py
  // does not override it; backend test_nearby_api asserts "12000.00"). A numeric price is tolerated.
  it.each([
    ['12000.00', '12000.00'],
    ['500', '500'],
    [12000, '12000'],
    [12000.5, '12000.5'],
  ])('normalises price %j to the string %j', (input, expected) => {
    const parsed = parseNearbyResponse(body({ results: [{ ...item, price_per_hour: input }] }));
    expect(parsed.results[0]?.pricePerHour).toBe(expected);
  });

  it('does not echo response content in the error message', () => {
    expect.assertions(2);
    try {
      parseNearbyResponse(body({ results: [{ ...item, name: 7, location: { lat: 41.123456, lng: 69.654321 } }] }));
    } catch (error) {
      expect((error as Error).message).not.toContain('41.123456');
      expect((error as Error).message).not.toContain('69.654321');
    }
  });
});
