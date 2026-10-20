import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import type { Booking } from '@/features/booking/bookingSchemas';
import { CountdownLine } from '@/features/booking/CountdownLine';
import { serverClock } from '@/features/booking/serverClock';
import { StatusChip } from '@/features/booking/StatusChip';
import { useWhenLabel } from '@/features/booking/useWhenLabel';
import { formatPrice } from '@/features/map/format';
import { RefundNote } from '@/features/payment/RefundNote';
import { useLanguage } from '@/features/map/useLanguage';
import { formatPlate } from '@/features/vehicles/vehiclePlate';
import { usePalette } from '@/theme/theme';

const MS_PER_MINUTE = 60_000;
const ZERO_MONEY = /^0+(?:\.0+)?$/;

function Row({ label, value }: { label: string; value: string }) {
  const p = usePalette();
  return (
    <View style={styles.row}>
      <Text style={{ color: p.textMuted }}>{label}</Text>
      <Text style={[styles.value, { color: p.text }]}>{value}</Text>
    </View>
  );
}

/** Status, lot, timer and the facts card of a booking. */
export function BookingSummary({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const whenLabel = useWhenLabel();
  const money = (value: string): string => formatPrice(value, lang) ?? value;
  const skewMinutes = Math.round(Math.abs(serverClock.skewMs()) / MS_PER_MINUTE);

  return (
    <>
      <StatusChip status={booking.status} />
      <Text style={[styles.lot, { color: p.text }]}>{booking.parkingLot.name}</Text>
      {booking.parkingLot.address ? <Text style={{ color: p.textMuted }}>{booking.parkingLot.address}</Text> : null}
      <CountdownLine booking={booking} />
      {skewMinutes >= 1 ? (
        <Text style={[styles.note, { color: p.textMuted }]}>{t('booking.detail.clockSkew', { minutes: skewMinutes })}</Text>
      ) : null}
      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
        <Row
          label={t('booking.detail.slot')}
          value={t('booking.detail.slotValue', { code: booking.slot.code, zone: booking.slot.zone, floor: booking.slot.floor })}
        />
        <Row label={t('booking.detail.time')} value={whenLabel(booking.startMs, booking.endMs)} />
        {booking.vehicle.plateNumber ? <Row label={t('booking.detail.vehicle')} value={formatPlate(booking.vehicle.plateNumber)} /> : null}
        <Row label={t('booking.detail.amount')} value={money(booking.amount)} />
        {!ZERO_MONEY.test(booking.paidAmount) ? <Row label={t('booking.detail.paid')} value={money(booking.paidAmount)} /> : null}
      </View>
      {/* refund_amount is a PROMISE: "refunded" is said only when refund_status is done (RefundNote). */}
      <RefundNote booking={booking} />
    </>
  );
}

const styles = StyleSheet.create({
  lot: { fontSize: 20, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  value: { flexShrink: 1, textAlign: 'right', fontWeight: '600' },
  note: { fontSize: 12 },
});
