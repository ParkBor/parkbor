import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import type { GateCard, Tone } from '@/features/operator/gateResult';
import { useCountdownSeconds } from '@/features/operator/useCountdownSeconds';
import { useOperatorFormat } from '@/features/operator/useFormat';
import { formatPlate } from '@/features/vehicles/vehiclePlate';
import { usePalette, type Palette } from '@/theme/theme';

/** Glyph on the coloured badge: dark enough for amber, readable on green / red (large bold text). */
const GLYPH_COLOR = '#111827';

function toneColors(tone: Tone, p: Palette): { fill: string; text: string } {
  if (tone === 'green') return { fill: p.success, text: p.successText };
  if (tone === 'amber') return { fill: p.warning, text: p.warningText };
  return { fill: p.error, text: p.error };
}

interface GateCardViewProps {
  card: GateCard;
  onDismiss: () => void;
  onRetry: () => void;
}

/**
 * Result of a scan. Tone is told three ways - colour, glyph and a text title - so it survives sun
 * glare and colour blindness. The card is the only live region on the scanner screen.
 */
export function GateCardView({ card, onDismiss, onRetry }: GateCardViewProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const fmt = useOperatorFormat();
  const colors = toneColors(card.tone, p);
  const waitLeft = useCountdownSeconds(card.retry === 'wait' ? card.retryAfterSec : null);
  const details = card.details;
  const canRetry = card.retry !== 'none';
  const retryBlocked = card.retry === 'wait' && waitLeft > 0;
  const title = t(card.titleKey);
  const reason = t(card.reasonKey);

  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: colors.fill }]}>
      {/* Only the verdict is the live region; the buttons below stay separately focusable. */}
      <View
        accessible
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
        accessibilityLabel={t('operator.a11y.result', { tone: title, reason })}
        style={styles.verdict}
      >
        <View style={styles.head}>
          <View style={[styles.badge, { backgroundColor: colors.fill }]}>
            <Text style={[styles.glyph, { color: GLYPH_COLOR }]}>{card.glyph}</Text>
          </View>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        </View>
        <Text style={[styles.reason, { color: p.text }]}>{reason}</Text>
      </View>

      {details ? (
        <View style={styles.details}>
          <Text style={[styles.plate, { color: p.text }]}>{formatPlate(details.plate)}</Text>
          {card.isCheckIn ? <Text style={[styles.confirm, { color: p.warningText }]}>{t('operator.card.confirmPlate')}</Text> : null}
          <Text style={[styles.line, { color: p.text }]}>
            {t('operator.card.slot')}: {details.slotCode} · {t('operator.card.zoneFloor', { zone: details.zone, floor: details.floor })}
          </Text>
          {details.startMs !== null && details.endMs !== null ? (
            <Text style={[styles.line, { color: p.textMuted }]}>
              {t('operator.card.period', { from: fmt.clock(details.startMs), to: fmt.clock(details.endMs) })}
            </Text>
          ) : null}
          {details.kind === 'WALK_IN' ? <Text style={[styles.line, { color: p.textMuted }]}>{t('operator.card.walkInTag')}</Text> : null}
          {details.checkoutByMs !== null ? (
            <Text style={[styles.line, { color: p.text }]}>{t('operator.card.leaveBy', { time: fmt.clock(details.checkoutByMs) })}</Text>
          ) : null}
          {details.actualMinutes !== null ? (
            <Text style={[styles.line, { color: p.text }]}>{t('operator.card.parked', { duration: fmt.duration(details.actualMinutes) })}</Text>
          ) : null}
          {details.overstayAmount !== null ? (
            <Text style={[styles.line, { color: p.warningText }]}>
              {t('operator.card.overstay')}: {fmt.money(details.overstayAmount)}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        {canRetry ? (
          <Button
            label={retryBlocked ? t('operator.scan.retryIn', { seconds: waitLeft }) : t('operator.scan.retry')}
            onPress={onRetry}
            disabled={retryBlocked}
          />
        ) : null}
        <Button variant="secondary" label={canRetry ? t('operator.card.dismiss') : t('operator.scan.next')} onPress={onDismiss} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 3, borderRadius: 20, padding: 16, gap: 10 },
  verdict: { gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 28, fontWeight: '800' },
  title: { fontSize: 24, fontWeight: '800' },
  reason: { fontSize: 20, fontWeight: '600' },
  details: { gap: 4 },
  plate: { fontSize: 40, fontWeight: '800', letterSpacing: 2 },
  confirm: { fontSize: 18, fontWeight: '700' },
  line: { fontSize: 16 },
  actions: { gap: 8, marginTop: 4 },
});
