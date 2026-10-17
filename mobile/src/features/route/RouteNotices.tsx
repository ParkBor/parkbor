import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDistance, formatDuration } from '@/features/map/format';
import { useLanguage } from '@/features/map/useLanguage';
import { routeErrorTextKey, type RouteErrorKind } from '@/features/route/routeError';
import type { RouteState } from '@/features/route/useRoute';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface ApproximateNoticeProps {
  /** Larger type for the in-car navigation screen. */
  isLarge?: boolean;
}

/** Mandatory warning for fallback / approximate routes: not a real road route. */
export function ApproximateNotice({ isLarge = false }: ApproximateNoticeProps) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <View
      accessibilityRole="alert"
      style={[styles.box, { backgroundColor: p.surface, borderColor: p.warningText }]}
    >
      <Text style={[styles.title, isLarge && styles.titleLarge, { color: p.warningText }]}>
        {t('route.approxTitle')}
      </Text>
      <Text style={[styles.text, isLarge && styles.textLarge, { color: p.text }]}>{t('route.approxText')}</Text>
    </View>
  );
}

interface RouteErrorNoticeProps {
  kind: RouteErrorKind;
  onRetry?: () => void;
  /** Extra line, e.g. "showing the previous route". */
  note?: string;
}

export function RouteErrorNotice({ kind, onRetry, note }: RouteErrorNoticeProps) {
  const { t } = useTranslation();
  const p = usePalette();
  // Retrying cannot fix these; offering the button would only invite more throttled calls.
  const canRetry = onRetry !== undefined && kind !== 'tooFar' && kind !== 'notFound' && kind !== 'badRequest';
  return (
    <View
      accessibilityRole="alert"
      style={[styles.box, { backgroundColor: p.surface, borderColor: p.error }]}
    >
      <Text style={[styles.text, { color: p.text }]}>{t(routeErrorTextKey(kind))}</Text>
      {note ? <Text style={[styles.note, { color: p.textMuted }]}>{note}</Text> : null}
      {canRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
          onPress={onRetry}
          style={styles.retry}
        >
          <Text style={[styles.retryLabel, { color: p.primary }]}>{t('common.retry')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

interface RoutePreviewSummaryProps {
  state: RouteState;
  onClear: () => void;
}

/** Route status inside the parking preview card: loading, error, or distance/time (+ warning). */
export function RoutePreviewSummary({ state, onClear }: RoutePreviewSummaryProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const { route } = state;

  if (state.error && !route) return <RouteErrorNotice kind={state.error} onRetry={state.refetch} />;
  if (!route) return <Text style={[styles.text, { color: p.textMuted }]}>{t('route.loading')}</Text>;

  const distance = formatDistance(route.distanceM, lang);
  const duration = formatDuration(route.durationS, lang) ?? '';
  return (
    <View style={styles.summary}>
      <View style={styles.summaryRow}>
        <Text style={[styles.summaryText, { color: p.text }]}>{t('route.summary', { distance, duration })}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('route.clear')}
          onPress={onClear}
          style={styles.retry}
        >
          <Text style={[styles.retryLabel, { color: p.primary }]}>{t('route.clear')}</Text>
        </Pressable>
      </View>
      {route.isApproximate ? <ApproximateNotice /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { gap: 8 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  summaryText: { fontSize: 18, fontWeight: '700', flexShrink: 1 },
  box: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 },
  title: { fontSize: 16, fontWeight: '700' },
  titleLarge: { fontSize: 20 },
  text: { fontSize: 14 },
  textLarge: { fontSize: 16 },
  note: { fontSize: 13 },
  retry: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  retryLabel: { fontSize: 16, fontWeight: '600' },
});
