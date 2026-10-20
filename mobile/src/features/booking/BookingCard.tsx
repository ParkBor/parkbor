import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import type { Booking } from '@/features/booking/bookingSchemas';
import { StatusChip } from '@/features/booking/StatusChip';
import { useNowAt } from '@/features/booking/useNowAt';
import { useWhenLabel } from '@/features/booking/useWhenLabel';
import { formatPrice } from '@/features/map/format';
import { useLanguage } from '@/features/map/useLanguage';
import { payAvailability } from '@/features/payment/payAvailability';
import { formatPlate } from '@/features/vehicles/vehiclePlate';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface BookingCardProps {
  booking: Booking;
  onPress: (booking: Booking) => void;
  /** "Pay" shortcut, shown only for a PENDING_PAYMENT booking whose hold is alive and payment URL valid. */
  onPay?: (booking: Booking) => void;
}

/** One row of "My bookings". Plate and ids are plain text; nothing here is logged. */
export function BookingCard({ booking, onPress, onPay }: BookingCardProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const when = useWhenLabel()(booking.startMs, booking.endMs);
  const amount = formatPrice(booking.amount, lang);
  const isPending = booking.status === 'PENDING_PAYMENT';
  const now = useNowAt(booking.holdExpiresAtMs, isPending);
  const canPay = onPay !== undefined && isPending && payAvailability(booking, now).kind === 'ready';
  const statusText = t(`booking.status.${booking.status}`);
  // The pay button is a sibling of the pressable row, not a child: no interactive element inside another.
  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('booking.list.item', { name: booking.parkingLot.name, status: statusText, when })}
        onPress={() => onPress(booking)}
        style={styles.body}
      >
      <View style={styles.row}>
        <Text style={[styles.name, { color: p.text }]} numberOfLines={1}>
          {booking.parkingLot.name}
        </Text>
        <StatusChip status={booking.status} />
      </View>
      <Text style={{ color: p.text }}>{when}</Text>
      <View style={styles.row}>
        <Text style={{ color: p.textMuted }}>
          {t('booking.detail.slotValue', { code: booking.slot.code, zone: booking.slot.zone, floor: booking.slot.floor })}
        </Text>
        {booking.vehicle.plateNumber ? <Text style={{ color: p.textMuted }}>{formatPlate(booking.vehicle.plateNumber)}</Text> : null}
      </View>
      {amount ? <Text style={[styles.amount, { color: p.text }]}>{amount}</Text> : null}
      </Pressable>
      {canPay ? <Button label={t('booking.detail.pay')} onPress={() => onPay(booking)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  body: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  name: { flex: 1, fontSize: 17, fontWeight: '700' },
  amount: { fontSize: 16, fontWeight: '700' },
});
