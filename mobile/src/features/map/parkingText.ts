import { formatDistance, formatDuration, formatPricePerHour, formatRating } from '@/features/map/format';
import { markerColor, type MarkerKind } from '@/features/map/markerColor';
import type { Parking } from '@/features/map/schemas';
import type { Language } from '@/lib/types';

export interface ParkingText {
  distance: string;
  /** null when the backend has no drive time. */
  duration: string | null;
  /** null when the price is not listed. */
  price: string | null;
  /** null when unrated. */
  rating: string | null;
  kind: MarkerKind;
}

/** Display strings shared by the list row and the preview card. */
export function describeParking(parking: Parking, lang: Language): ParkingText {
  return {
    distance: formatDistance(parking.distanceM, lang),
    duration: formatDuration(parking.durationS, lang),
    price: formatPricePerHour(parking.pricePerHour, lang),
    rating: formatRating(parking.rating, lang),
    kind: markerColor(parking.freeSlots, parking.totalSlots, parking.isOpen),
  };
}
