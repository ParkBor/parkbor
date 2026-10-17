import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import type { LotStatus, MapBooking, MapSlot } from '@/features/operator/operatorSchemas';
import { slotToneColors } from '@/features/operator/slotColors';
import { availableSlotActions, describeBooking, slotVisual } from '@/features/operator/slotView';
import { useOperatorFormat } from '@/features/operator/useFormat';
import { formatPlate } from '@/features/vehicles/vehiclePlate';
import { usePalette } from '@/theme/theme';

interface SlotDetailProps {
  slot: MapSlot | null;
  lotStatus: LotStatus;
  isBusy: boolean;
  errorText: string | null;
  onClose: () => void;
  onSetStatus: (status: 'FREE' | 'OUT_OF_SERVICE') => void;
}

function BookingBlock({ title, booking }: { title: string; booking: MapBooking }) {
  const { t } = useTranslation();
  const p = usePalette();
  const fmt = useOperatorFormat();
  const line = describeBooking(booking);
  return (
    <View style={styles.block}>
      <Text style={[styles.blockTitle, { color: p.textMuted }]}>{title}</Text>
      {line.plate !== null ? (
        <Text style={[styles.plate, { color: p.text }]}>{formatPlate(line.plate)}</Text>
      ) : (
        <Text style={{ color: p.textMuted }}>{t('operator.slots.plateHidden')}</Text>
      )}
      <Text style={{ color: p.text }}>
        {fmt.clock(line.startMs)} – {fmt.clock(line.endMs)}
        {line.kind === 'WALK_IN' ? ` · ${t('operator.card.walkInTag')}` : line.kind === 'ONLINE' ? ` · ${t('operator.slots.online')}` : ''}
      </Text>
    </View>
  );
}

/** Bottom sheet with a slot's details. Plates shown here are the ones the server chose to send. */
export function SlotDetail({ slot, lotStatus, isBusy, errorText, onClose, onSetStatus }: SlotDetailProps) {
  const { t } = useTranslation();
  const p = usePalette();
  if (slot === null) return null;
  const visual = slotVisual(slot);
  const colors = slotToneColors(visual.tone, p);
  const actions = availableSlotActions(slot, lotStatus);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel={t('operator.card.dismiss')} style={styles.backdrop} onPress={onClose} />
      <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: p.background, borderColor: p.border }]}>
        <ScrollView contentContainerStyle={styles.body}>
          <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
            {t('operator.slots.detailTitle', { code: slot.code })}
          </Text>
          <Text style={[styles.state, { color: colors.text }]}>
            {visual.glyph} {t(visual.labelKey)}
          </Text>
          <Text style={{ color: p.textMuted }}>
            {t('operator.card.zoneFloor', { zone: slot.zone, floor: slot.floor })} · {t('operator.slots.type', { type: t(`operator.slotType.${slot.type}`) })}
          </Text>
          {slot.current ? <BookingBlock title={t('operator.slots.current')} booking={slot.current} /> : null}
          {slot.next ? <BookingBlock title={t('operator.slots.next')} booking={slot.next} /> : null}
          {errorText ? (
            <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: p.error }}>
              {errorText}
            </Text>
          ) : null}
          {actions.markOutOfService ? (
            <Button label={t('operator.slots.setOutOfService')} onPress={() => onSetStatus('OUT_OF_SERVICE')} loading={isBusy} />
          ) : null}
          {actions.markFree ? <Button label={t('operator.slots.setFree')} onPress={() => onSetStatus('FREE')} loading={isBusy} /> : null}
          <Button variant="secondary" label={t('operator.card.dismiss')} onPress={onClose} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { maxHeight: '75%', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1 },
  body: { padding: 20, gap: 10 },
  title: { fontSize: 22, fontWeight: '800' },
  state: { fontSize: 18, fontWeight: '700' },
  block: { gap: 2 },
  blockTitle: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
  plate: { fontSize: 28, fontWeight: '800', letterSpacing: 1.5 },
});
