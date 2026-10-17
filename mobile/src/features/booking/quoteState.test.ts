import { describe, expect, it } from 'vitest';

import { rawAvailability, rawPrice } from '@/features/booking/fixtures';
import { evaluateQuote, quoteMatches, type QuoteFlags } from '@/features/booking/quoteState';
import { parseAvailability, parsePrice } from '@/features/booking/quoteSchemas';

const START = Date.UTC(2026, 9, 15, 9, 0, 0);
const request = { slotType: 'STANDARD', startMs: START, endMs: START + 2 * 3_600_000 } as const;
const price = parsePrice(rawPrice());
const availability = parseAvailability(rawAvailability());
const settled: QuoteFlags = { isSettled: true, isPlaceholder: false, isFetching: false };

describe('quoteMatches', () => {
  it('is true when slot type, start and end are the requested ones', () => {
    expect(quoteMatches(price, request)).toBe(true);
    expect(quoteMatches(availability, request)).toBe(true);
  });

  it('is false for another period or slot type (stale data from a previous selection)', () => {
    expect(quoteMatches(price, { ...request, endMs: request.endMs + 900_000 })).toBe(false);
    expect(quoteMatches(price, { ...request, startMs: START + 900_000 })).toBe(false);
    expect(quoteMatches(price, { ...request, slotType: 'EV' })).toBe(false);
  });

  it('is false without data', () => {
    expect(quoteMatches(undefined, request)).toBe(false);
  });
});

describe('evaluateQuote', () => {
  it('current data allows submitting', () => {
    expect(evaluateQuote(request, price, availability, settled)).toEqual({ isCurrent: true, isStale: false, canSubmit: true });
  });

  it('placeholder data (previous period kept while loading) never allows submitting', () => {
    const result = evaluateQuote(request, price, availability, { ...settled, isPlaceholder: true });
    expect(result).toEqual({ isCurrent: false, isStale: true, canSubmit: false });
  });

  it('a price for another period is stale even without the placeholder flag', () => {
    const other = parsePrice(rawPrice({ end: '2026-10-15T17:00:00+05:00' }));
    expect(evaluateQuote(request, other, availability, settled).canSubmit).toBe(false);
  });

  it('an unsettled (debouncing) or fetching request blocks submitting', () => {
    expect(evaluateQuote(request, price, availability, { ...settled, isSettled: false }).canSubmit).toBe(false);
    expect(evaluateQuote(request, price, availability, { ...settled, isFetching: true }).canSubmit).toBe(false);
  });

  it('a closed or full lot blocks submitting', () => {
    const closed = parseAvailability(rawAvailability({ is_open: false, available: 0 }));
    const full = parseAvailability(rawAvailability({ available: 0 }));
    expect(evaluateQuote(request, price, closed, settled).canSubmit).toBe(false);
    expect(evaluateQuote(request, price, full, settled).canSubmit).toBe(false);
  });

  it('missing availability does not block (the server decides) but a missing price does', () => {
    expect(evaluateQuote(request, price, undefined, settled).canSubmit).toBe(true);
    expect(evaluateQuote(request, undefined, availability, settled).canSubmit).toBe(false);
  });
});
