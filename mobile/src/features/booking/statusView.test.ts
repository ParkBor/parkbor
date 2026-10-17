import { describe, expect, it } from 'vitest';

import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';
import uz from '@/i18n/uz.json';
import { darkPalette, lightPalette } from '@/theme/palette';
import { BOOKING_STATUSES } from '@/features/booking/bookingSchemas';
import {
  canCancelStatus,
  canShowQr,
  isLiveStatus,
  statusTone,
  statusView,
  toneColor,
} from '@/features/booking/statusView';

describe('statusView', () => {
  it('gives every known status a label key, a glyph and a tone', () => {
    for (const status of [...BOOKING_STATUSES, 'unknown'] as const) {
      const view = statusView(status);
      expect(view.labelKey).toBe(`booking.status.${status}`);
      expect(view.glyph.length).toBeGreaterThan(0);
      expect(['success', 'warning', 'error', 'primary', 'muted']).toContain(view.tone);
    }
  });

  it('has a label for every status in every language', () => {
    for (const catalog of [uz, ru, en]) {
      const labels = catalog.booking.status as Record<string, string>;
      for (const status of [...BOOKING_STATUSES, 'unknown']) expect(labels[status], status).toBeTruthy();
    }
  });

  it('never relies on colour alone: glyphs are distinct across tones', () => {
    const glyphs = new Map<string, string>();
    for (const status of [...BOOKING_STATUSES, 'unknown'] as const) {
      const { glyph, tone } = statusView(status);
      const previous = glyphs.get(glyph);
      expect(previous === undefined || previous === tone, `${status} shares a glyph with another tone`).toBe(true);
      glyphs.set(glyph, tone);
    }
  });

  it('maps tones sensibly', () => {
    expect(statusTone('CONFIRMED')).toBe('success');
    expect(statusTone('ACTIVE')).toBe('primary');
    expect(statusTone('PENDING_PAYMENT')).toBe('warning');
    expect(statusTone('OVERSTAY')).toBe('error');
    expect(statusTone('CANCELLED')).toBe('muted');
    expect(statusTone('unknown')).toBe('muted');
  });

  it('resolves tones to palette colours in both themes', () => {
    for (const palette of [lightPalette, darkPalette]) {
      expect(toneColor('success', palette)).toBe(palette.successText);
      expect(toneColor('warning', palette)).toBe(palette.warningText);
      expect(toneColor('error', palette)).toBe(palette.error);
      expect(toneColor('primary', palette)).toBe(palette.primary);
      expect(toneColor('muted', palette)).toBe(palette.textMuted);
    }
  });
});

describe('status capabilities', () => {
  it('QR only for CONFIRMED and ACTIVE (server: 409 qr_not_available otherwise)', () => {
    expect(canShowQr('CONFIRMED')).toBe(true);
    expect(canShowQr('ACTIVE')).toBe(true);
    for (const status of ['PENDING_PAYMENT', 'OVERSTAY', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW', 'unknown'] as const) {
      expect(canShowQr(status), status).toBe(false);
    }
  });

  it('cancel is offered only before check-in', () => {
    expect(canCancelStatus('PENDING_PAYMENT')).toBe(true);
    expect(canCancelStatus('CONFIRMED')).toBe(true);
    for (const status of ['ACTIVE', 'OVERSTAY', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW', 'unknown'] as const) {
      expect(canCancelStatus(status), status).toBe(false);
    }
  });

  it('live statuses poll for changes', () => {
    expect(isLiveStatus('PENDING_PAYMENT')).toBe(true);
    expect(isLiveStatus('CONFIRMED')).toBe(true);
    expect(isLiveStatus('ACTIVE')).toBe(true);
    expect(isLiveStatus('OVERSTAY')).toBe(true);
    expect(isLiveStatus('COMPLETED')).toBe(false);
    expect(isLiveStatus('unknown')).toBe(false);
  });
});
