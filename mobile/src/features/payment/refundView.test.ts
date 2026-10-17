import { describe, expect, it } from 'vitest';

import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';
import uz from '@/i18n/uz.json';
import { parseRefundStatus, REFUND_STATUSES, refundView } from '@/features/payment/refundView';

describe('parseRefundStatus', () => {
  it.each(['none', 'pending', 'done', 'manual', 'failed'])('keeps the known status %s', (value) => {
    expect(parseRefundStatus(value)).toBe(value);
  });

  it('a missing field (older server) is "none"', () => {
    expect(parseRefundStatus(undefined)).toBe('none');
  });

  it.each([null, '', 'DONE', 'refunded', 'sent', 7, true, {}, []])('an unrecognised value %o is "unknown"', (value) => {
    expect(parseRefundStatus(value)).toBe('unknown');
  });
});

describe('refundView', () => {
  it('shows nothing when there is no refund at all', () => {
    expect(refundView('none', '0.00')).toBeNull();
    expect(refundView('none', '0')).toBeNull();
  });

  it('a promised amount with nothing started is a promise, never "refunded"', () => {
    const view = refundView('none', '6000.00');
    expect(view?.textKey).toBe('booking.refund.promised');
    expect(view?.amountLabelKey).toBe('booking.detail.refundDue');
    expect(view?.hasAmount).toBe(true);
  });

  it.each(['pending', 'manual', 'failed', 'unknown'] as const)('%s keeps the amount labelled as owed, not refunded', (status) => {
    const view = refundView(status, '6000.00');
    expect(view?.amountLabelKey).toBe('booking.detail.refundDue');
    expect(view?.textKey).toBe(`booking.refund.${status}`);
  });

  it('only "done" says the money was returned', () => {
    const view = refundView('done', '6000.00');
    expect(view?.textKey).toBe('booking.refund.done');
    expect(view?.amountLabelKey).toBe('booking.detail.refunded');
    expect(view?.tone).toBe('success');
  });

  it('tones: pending warns, manual warns, failed is an error', () => {
    expect(refundView('pending', '1.00')?.tone).toBe('warning');
    expect(refundView('manual', '1.00')?.tone).toBe('warning');
    expect(refundView('failed', '1.00')?.tone).toBe('error');
    expect(refundView('unknown', '1.00')?.tone).toBe('muted');
  });

  it('a status without an amount still explains itself (the amount row is hidden)', () => {
    const view = refundView('manual', '0.00');
    expect(view?.textKey).toBe('booking.refund.manual');
    expect(view?.hasAmount).toBe(false);
  });

  it('every status maps to an existing i18n key in all languages', () => {
    for (const status of REFUND_STATUSES) {
      const view = refundView(status, '1000.00');
      if (!view) continue;
      const leaf = view.textKey.replace('booking.refund.', '');
      for (const catalog of [uz, ru, en]) {
        expect((catalog.booking.refund as Record<string, string>)[leaf], `${status}/${leaf}`).toBeTruthy();
      }
    }
    for (const catalog of [uz, ru, en]) {
      expect(catalog.booking.detail.refundDue).toBeTruthy();
      expect(catalog.booking.detail.refunded).toBeTruthy();
    }
  });

  it('manual and failed texts carry the concrete advice (1-3 working days / contact support)', () => {
    expect(uz.booking.refund.manual).toMatch(/1[–-]3/);
    expect(en.booking.refund.manual).toMatch(/1[–-]3/);
    expect(ru.booking.refund.manual).toMatch(/1[–-]3/);
    expect(en.booking.refund.failed).toMatch(/support/i);
  });

  it('only the "done" text claims the money came back', () => {
    for (const status of ['promised', 'pending', 'manual', 'failed', 'unknown'] as const) {
      expect(en.booking.refund[status].toLowerCase()).not.toMatch(/\bhas been refunded\b|\bwas refunded\b|\bis refunded\b/);
    }
  });
});
