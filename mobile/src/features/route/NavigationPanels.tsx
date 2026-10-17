import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDistance, formatDuration } from '@/features/map/format';
import { compassText, describeInstruction } from '@/features/route/instructionText';
import type { NavigationViewKind, RemainingSummary } from '@/features/route/navigationView';
import type { FallbackGuidance, Progress } from '@/features/route/routeProgress';
import type { Language } from '@/lib/types';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

/** Bigger than the 48 dp minimum: the driver may be pressing it in a moving car. */
const BIG_TOUCH = 60;

interface CardProps {
  kind: NavigationViewKind;
  progress: Progress | null;
  guidance: FallbackGuidance | null;
  isRerouting: boolean;
  lang: Language;
}

interface CardText {
  title: string;
  detail: string | null;
  sub: string | null;
}

function useCardText({ kind, progress, guidance, isRerouting, lang }: CardProps): CardText {
  const { t } = useTranslation();
  switch (kind) {
    case 'turn': {
      const next = progress?.nextStep;
      const described = next ? describeInstruction(next.step, lang) : null;
      const distanceM = next ? next.distanceM : (progress?.remainingM ?? 0);
      return { title: formatDistance(distanceM, lang), detail: described?.text ?? null, sub: described?.street ?? null };
    }
    case 'offRoute':
      // The old maneuver no longer applies: say so instead of showing a stale "turn left".
      return { title: t('nav.offRoute'), detail: isRerouting ? t('nav.rerouting') : null, sub: null };
    case 'arrived':
      return { title: t('nav.arrived'), detail: null, sub: null };
    case 'approximate':
      return guidance
        ? {
            title: formatDistance(guidance.distanceM, lang),
            detail: t('nav.straightLine', { direction: compassText(guidance.cardinal, lang) }),
            sub: t('nav.approxHint'),
          }
        : { title: t('nav.approxHint'), detail: null, sub: null };
    case 'loading':
      return { title: t('route.loading'), detail: null, sub: null };
    case 'waitingFix':
      return { title: t('nav.waitingFix'), detail: null, sub: null };
    case 'routeOnly':
    case 'locationOff':
      return { title: t('nav.locationOffTitle'), detail: t('nav.locationOffText'), sub: null };
    case 'error':
      return { title: t('route.error.generic'), detail: null, sub: null };
  }
}

/**
 * The one main card: next maneuver + distance, in large type with as little text as possible.
 * Not a live region: the screen reader is told about changes by announceForAccessibility, only
 * when the step or its proximity class changes (see announcementKey).
 */
export function InstructionCard(props: CardProps) {
  const p = usePalette();
  const { title, detail, sub } = useCardText(props);
  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={[title, detail, sub].filter(Boolean).join('. ')}
      style={[styles.card, { backgroundColor: p.surface, borderColor: p.primary }]}
    >
      <Text style={[styles.title, { color: p.text }]} numberOfLines={2} adjustsFontSizeToFit>
        {title}
      </Text>
      {detail ? (
        <Text style={[styles.detail, { color: p.text }]} numberOfLines={2}>
          {detail}
        </Text>
      ) : null}
      {sub ? (
        <Text style={[styles.sub, { color: p.textMuted }]} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

interface BarProps {
  remaining: RemainingSummary | null;
  lang: Language;
  isArrived: boolean;
  bottomInset: number;
  onExternal: () => void;
  onStop: () => void;
  onFindAnother: () => void;
}

/** Remaining distance/time and the action buttons, at the bottom for one-hand use. */
export function BottomBar({ remaining, lang, isArrived, bottomInset, onExternal, onStop, onFindAnother }: BarProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const distance = remaining ? formatDistance(remaining.distanceM, lang) : null;
  const duration = remaining ? formatDuration(remaining.durationS, lang) : null;
  const summary = distance && duration ? t('route.summary', { distance, duration }) : null;

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: p.background, borderColor: p.border, paddingBottom: 16 + bottomInset },
      ]}
    >
      {summary ? (
        <Text
          accessibilityLabel={t('nav.remainingLabel', { distance, duration })}
          style={[styles.remaining, { color: p.text }]}
        >
          {summary}
        </Text>
      ) : null}
      <View style={styles.buttons}>
        <BigButton label={t('nav.external')} variant="secondary" onPress={onExternal} />
        <BigButton label={isArrived ? t('nav.finish') : t('nav.stop')} variant="danger" onPress={onStop} />
      </View>
      {isArrived ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('nav.findAnother')}
          onPress={onFindAnother}
          style={styles.link}
        >
          <Text style={[styles.linkLabel, { color: p.primary }]}>{t('nav.findAnother')}</Text>
        </Pressable>
      )}
    </View>
  );
}

interface BigButtonProps {
  label: string;
  variant: 'secondary' | 'danger';
  onPress: () => void;
}

function BigButton({ label, variant, onPress }: BigButtonProps) {
  const p = usePalette();
  const isDanger = variant === 'danger';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.button,
        isDanger
          ? { backgroundColor: p.error, borderColor: p.error }
          : { backgroundColor: 'transparent', borderColor: p.primary },
      ]}
    >
      <Text style={[styles.buttonLabel, { color: isDanger ? p.onError : p.primary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 2, padding: 16, gap: 4 },
  title: { fontSize: 44, fontWeight: '800' },
  detail: { fontSize: 28, fontWeight: '700' },
  sub: { fontSize: 20 },
  bar: { borderTopWidth: 1, paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  remaining: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
  buttons: { flexDirection: 'row', gap: 12 },
  button: {
    flex: 1,
    minHeight: BIG_TOUCH,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  buttonLabel: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  link: { minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  linkLabel: { fontSize: 18, fontWeight: '600' },
});
