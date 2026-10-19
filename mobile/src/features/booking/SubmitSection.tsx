import { useTranslation } from 'react-i18next';
import { StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import type { Failure } from '@/lib/failure';
import { usePalette } from '@/theme/theme';

interface SubmitSectionProps {
  failure: Failure | null;
  isPending: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
}

/** "Pay and book", the failure of the last attempt (with the retry reassurance) and the hold note. */
export function SubmitSection({ failure, isPending, canSubmit, onSubmit }: SubmitSectionProps) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <>
      {failure ? (
        <>
          <ErrorText message={t(failure.key)} />
          {failure.retry === 'same_key' ? (
            <Text style={[styles.note, { color: p.textMuted }]}>{t('booking.form.retryHint')}</Text>
          ) : null}
        </>
      ) : null}
      <Button
        testID="booking-submit"
        label={isPending ? t('booking.form.submitting') : t('booking.form.submit')}
        loading={isPending}
        disabled={!canSubmit}
        onPress={onSubmit}
      />
      <Text style={[styles.note, { color: p.textMuted }]}>{t('booking.form.holdNote')}</Text>
    </>
  );
}

const styles = StyleSheet.create({ note: { fontSize: 13, textAlign: 'center' } });
