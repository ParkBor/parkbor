import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { differsFromTashkent } from '@/features/booking/timeSlots';
import { serverClock } from '@/features/booking/serverClock';
import { describeWhen } from '@/features/booking/whenText';

/** True when the device's zone at `ms` is not UTC+5, i.e. the shown clock times are not the phone's local time. */
export function isNotTashkentDevice(ms: number): boolean {
  return differsFromTashkent(-new Date(ms).getTimezoneOffset());
}

/**
 * "Today, 15:00 — 17:00" / "16.10, 09:00 — 10:00 (+1)" in Asia/Tashkent time, translated.
 * On a phone set to another zone the label says "(Tashkent time)": lots, tariffs and working
 * hours are all defined in that zone.
 */
export function useWhenLabel(): (startMs: number, endMs: number) => string {
  const { t } = useTranslation();
  return useCallback(
    (startMs, endMs) => {
      const when = describeWhen(startMs, endMs, serverClock.now());
      const day =
        when.dayKind === 'today' ? t('booking.form.today') : when.dayKind === 'tomorrow' ? t('booking.form.tomorrow') : when.dateText;
      const zone = isNotTashkentDevice(startMs) ? ` (${t('booking.form.tashkentTime')})` : '';
      return `${day}, ${when.from} — ${when.to}${when.endsNextDay ? ' (+1)' : ''}${zone}`;
    },
    [t],
  );
}
