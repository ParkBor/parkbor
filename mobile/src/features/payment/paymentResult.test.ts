import { describe, expect, it } from 'vitest';

import { parsePaymentResultParams, parsePaymentResultUrl } from '@/features/payment/paymentResult';

const ID = 'e4d0c1de-1111-4222-8333-444455556666';
const OTHER = 'a91c1de0-1111-4222-8333-444455556666';

describe('parsePaymentResultParams (expo-router params of habi://payment/result)', () => {
  it('takes a valid booking id', () => {
    expect(parsePaymentResultParams({ id: ID })).toEqual({ bookingId: ID });
  });

  it('knows the usual parameter names, first valid one wins', () => {
    expect(parsePaymentResultParams({ booking: ID })).toEqual({ bookingId: ID });
    expect(parsePaymentResultParams({ booking_id: ID })).toEqual({ bookingId: ID });
    expect(parsePaymentResultParams({ transaction_param: ID })).toEqual({ bookingId: ID });
    expect(parsePaymentResultParams({ id: 'junk', booking: ID })).toEqual({ bookingId: ID });
    expect(parsePaymentResultParams({ id: ID, booking: OTHER })).toEqual({ bookingId: ID });
  });

  it('reads the first element of an array parameter', () => {
    expect(parsePaymentResultParams({ id: [ID, OTHER] })).toEqual({ bookingId: ID });
    expect(parsePaymentResultParams({ id: [] })).toEqual({ bookingId: null });
  });

  it.each([
    ['not a UUID', 'abc'],
    ['empty', ''],
    ['path smuggling', `${ID}/cancel`],
    ['query smuggling', `${ID}?x=1`],
    ['uuid with spaces', ` ${ID}`],
    ['sql', "1' OR '1'='1"],
  ])('ignores an id that is %s', (_name, value) => {
    expect(parsePaymentResultParams({ id: value })).toEqual({ bookingId: null });
  });

  it('never exposes a status taken from the link (it is only a signal)', () => {
    const signal = parsePaymentResultParams({ id: ID, status: 'CONFIRMED', paid: 'true', success: '1', amount: '1' });
    expect(signal).toEqual({ bookingId: ID });
    expect(Object.keys(signal)).toEqual(['bookingId']);
  });

  it('handles empty input', () => {
    expect(parsePaymentResultParams({})).toEqual({ bookingId: null });
  });

  it('does not read inherited prototype keys', () => {
    const polluted = Object.create({ id: ID }) as Record<string, string>;
    expect(parsePaymentResultParams(polluted)).toEqual({ bookingId: null });
  });
});

describe('parsePaymentResultUrl', () => {
  it('returns null for anything that is not the result link', () => {
    expect(parsePaymentResultUrl('https://checkout.paycom.uz/x')).toBeNull();
    expect(parsePaymentResultUrl('habi://payment/result/x')).toBeNull();
    expect(parsePaymentResultUrl('')).toBeNull();
    expect(parsePaymentResultUrl(undefined)).toBeNull();
  });

  it('extracts the booking id from the query', () => {
    expect(parsePaymentResultUrl(`habi://payment/result?id=${ID}`)).toEqual({ bookingId: ID });
    expect(parsePaymentResultUrl(`habi://payment/result?status=ok&transaction_param=${ID}#x`)).toEqual({ bookingId: ID });
  });

  it('a link without an id is still a valid signal', () => {
    expect(parsePaymentResultUrl('habi://payment/result')).toEqual({ bookingId: null });
    expect(parsePaymentResultUrl('habi://payment/result?status=success')).toEqual({ bookingId: null });
  });

  it('survives broken percent-encoding and junk', () => {
    expect(parsePaymentResultUrl('habi://payment/result?id=%E0%A4%A&x')).toEqual({ bookingId: null });
    expect(parsePaymentResultUrl('habi://payment/result?&&=&id')).toEqual({ bookingId: null });
  });

  it('decodes an encoded id', () => {
    expect(parsePaymentResultUrl(`habi://payment/result?id=${encodeURIComponent(ID)}`)).toEqual({ bookingId: ID });
  });

  it('never carries the status from the link', () => {
    const signal = parsePaymentResultUrl(`habi://payment/result?id=${ID}&status=CONFIRMED`);
    expect(signal).toEqual({ bookingId: ID });
  });
});
