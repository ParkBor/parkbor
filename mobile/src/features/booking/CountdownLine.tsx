import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text } from 'react-native';

import type { Booking } from '@/features/booking/bookingSchemas';
import { deriveCountdown, formatRemaining } from '@/features/booking/countdown';
import { bookingKeys } from '@/features/booking/queryKeys';
import { useServerNow } from '@/features/booking/useServerNow';
import { useLanguage } from '@/features/map/useLanguage';
import { usePalette } from '@/theme/theme';

const LABEL_KEY = {
  hold: 'booking.detail.countdownHold',
  untilStart: 'booking.detail.countdownStart',
  untilEnd: 'booking.detail.countdownEnd',
} as const;

const REFETCH_DELAY_MS = 2000;

/**
 * Timer for hold / start / end, driven by the SERVER-corrected clock (serverClock, learnt from the
 * response `Date` header): the targets are server timestamps and the device clock may be off.
 * When a hold runs out the booking is reloaded - the server (not this timer) decides it expired.
 */
export function CountdownLine({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const queryClient = useQueryClient();
  const now = useServerNow(1000);
  const countdown = deriveCountdown(booking, now);
  const isHoldOver = countdown.kind === 'hold' && countdown.isOver;
  const bookingId = booking.id;

  useEffect(() => {
    if (!isHoldOver) return undefined;
    const id = setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(bookingId) }),
      REFETCH_DELAY_MS,
    );
    return () => clearTimeout(id);
  }, [isHoldOver, bookingId, queryClient]);

  if (countdown.kind === 'none') return null;
  if (countdown.isOver) {
    return (
      <Text accessibilityLiveRegion="polite" style={[styles.over, { color: p.error }]}>
        {countdown.kind === 'hold' ? t('booking.detail.holdOver') : t('booking.detail.overtime')}
      </Text>
    );
  }
  const time = formatRemaining(countdown.remainingMs, lang);
  return (
    <Text accessibilityRole="timer" accessibilityLabel={`${t(LABEL_KEY[countdown.kind])} ${time}`} style={[styles.time, { color: p.text }]}>
      {t(LABEL_KEY[countdown.kind])}: {time}
    </Text>
  );
}

const styles = StyleSheet.create({
  time: { fontSize: 22, fontWeight: '700' },
  over: { fontSize: 16, fontWeight: '700' },
});
