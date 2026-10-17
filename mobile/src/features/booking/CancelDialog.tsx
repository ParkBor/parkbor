import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import type { Booking } from '@/features/booking/bookingSchemas';
import { classifyBookingError } from '@/features/booking/bookingErrors';
import { canConfirmCancel, describeRefund } from '@/features/booking/refundText';
import { useCancelBooking, useCancelPreview } from '@/features/booking/useCancelBooking';
import { useLanguage } from '@/features/map/useLanguage';
import { usePalette } from '@/theme/theme';

interface CancelDialogProps {
  booking: Booking;
  isOpen: boolean;
  onClose: () => void;
  /** Called after the booking was cancelled. */
  onCancelled: () => void;
}

/** Shows the refundable amount first (server cancel-preview), then asks for confirmation. */
export function CancelDialog({ booking, isOpen, onClose, onCancelled }: CancelDialogProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const preview = useCancelPreview(booking.id, isOpen);
  const { cancel, mutation } = useCancelBooking(booking.id);

  const refund = preview.data && !preview.isFetching ? describeRefund(preview.data, booking.status, lang) : null;
  // Not while a refetch runs: the amount on screen could be from the previous opening.
  const canConfirm = canConfirmCancel({ isFetching: preview.isFetching, isError: preview.isError, data: preview.data });
  const failure = mutation.isError ? classifyBookingError(mutation.error) : null;

  const confirm = async (): Promise<void> => {
    if (await cancel()) {
      mutation.reset();
      onCancelled();
    }
  };

  const close = (): void => {
    if (mutation.isPending) return;
    mutation.reset();
    onClose();
  };

  return (
    <Modal visible={isOpen} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: p.background, borderColor: p.border }]} accessibilityViewIsModal>
          <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
            {t('booking.cancel.title')}
          </Text>
          {preview.isPending || preview.isFetching ? (
            <View style={styles.row}>
              <ActivityIndicator color={p.primary} />
              <Text style={{ color: p.textMuted }}>{t('booking.cancel.loading')}</Text>
            </View>
          ) : refund ? (
            <Text style={{ color: p.text }} accessibilityLiveRegion="polite">
              {t(refund.key, refund.params)}
            </Text>
          ) : (
            <Text style={{ color: p.warningText }}>{t('booking.cancel.previewError')}</Text>
          )}
          <ErrorText message={failure ? t(failure.key) : null} />
          <Button
            label={mutation.isPending ? t('booking.cancel.working') : t('booking.cancel.confirm')}
            variant="secondary"
            loading={mutation.isPending}
            disabled={!canConfirm}
            onPress={() => void confirm()}
          />
          <Button label={t('booking.cancel.keep')} disabled={mutation.isPending} onPress={close} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 24, gap: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
