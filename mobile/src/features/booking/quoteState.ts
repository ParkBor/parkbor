import type { Availability, Price } from '@/features/booking/quoteSchemas';

export interface QuoteRequest {
  slotType: string;
  startMs: number;
  endMs: number;
}

export interface QuoteFlags {
  /** The debounced request equals the current selection. */
  isSettled: boolean;
  /** TanStack is showing the previous period's data while the new one loads (keepPreviousData). */
  isPlaceholder: boolean;
  isFetching: boolean;
}

export interface QuoteVerdict {
  isCurrent: boolean;
  isStale: boolean;
  canSubmit: boolean;
}

type Quoted = Pick<Price | Availability, 'startMs' | 'endMs' | 'slotType'>;

/** The data describes exactly the requested slot type and period (not a previous selection). */
export function quoteMatches(data: Quoted | undefined, request: QuoteRequest): boolean {
  return data !== undefined && data.slotType === request.slotType && data.startMs === request.startMs && data.endMs === request.endMs;
}

/**
 * Whether the price on screen may be paid. Placeholder data from the previous period, data for
 * another period, an unsettled or running request all keep "Pay and book" disabled: the user
 * must never confirm a price that was not computed for the period on screen.
 * Missing availability does not block (the server decides), a missing price does.
 */
export function evaluateQuote(
  request: QuoteRequest,
  price: Price | undefined,
  availability: Availability | undefined,
  flags: QuoteFlags,
): QuoteVerdict {
  const isCurrent = quoteMatches(price, request) && !flags.isPlaceholder && flags.isSettled;
  const isStale = price !== undefined && !isCurrent;
  const availabilityOk =
    availability === undefined || !quoteMatches(availability, request) || (availability.isOpen && availability.available > 0);
  return { isCurrent, isStale, canSubmit: isCurrent && !flags.isFetching && availabilityOk };
}
