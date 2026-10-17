import { describe, expect, it } from 'vitest';

import { describeParking } from '@/features/map/parkingText';
import type { Parking } from '@/features/map/schemas';

const base: Parking = {
  id: '1',
  name: 'Chorsu',
  address: '',
  location: { lat: 41.3, lng: 69.2 },
  distanceM: 1200,
  durationS: 300,
  freeSlots: 12,
  totalSlots: 50,
  pricePerHour: '5000.00',
  rating: 4.6,
  isOpen: true,
  score: null,
};

describe('describeParking', () => {
  it('formats all fields for the active language', () => {
    expect(describeParking(base, 'en')).toEqual({
      distance: '1.2 km',
      duration: '5 min',
      price: '5,000 UZS/h',
      rating: '4.6',
      kind: 'yellow', // 12 of 50 = 24% free
    });
  });

  it('keeps optional fields null and flags closed lots as gray', () => {
    const text = describeParking(
      { ...base, durationS: null, pricePerHour: null, rating: null, isOpen: false },
      'uz',
    );
    expect(text).toMatchObject({ duration: null, price: null, rating: null, kind: 'gray' });
  });
});
