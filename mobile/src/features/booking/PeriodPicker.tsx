import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Chip } from '@/components/Chip';
import {
  adjustDuration,
  applyQuickDuration,
  draftDurationMin,
  selectDay,
  selectStart,
  type BookingDraft,
} from '@/features/booking/bookingDraft';
import { formatClock, QUICK_DURATIONS_MIN, startOptions } from '@/features/booking/timeSlots';
import { isNotTashkentDevice, useWhenLabel } from '@/features/booking/useWhenLabel';
import { formatDuration } from '@/features/map/format';
import { useLanguage } from '@/features/map/useLanguage';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface PeriodPickerProps {
  draft: BookingDraft;
  nowMs: number;
  onChange: (draft: BookingDraft) => void;
}

const ITEM_WIDTH = 92;
const STEP_DELTA_MIN = 15;

/** Day (today / tomorrow), start time in 15-minute steps, duration (+/-15 min, quick 1/2/3 h). */
export function PeriodPicker({ draft, nowMs, onChange }: PeriodPickerProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const whenLabel = useWhenLabel();
  const listRef = useRef<FlatList<number>>(null);
  const options = startOptions(draft.day, nowMs);
  const selectedIndex = options.indexOf(draft.startMs);
  const duration = draftDurationMin(draft);
  const hasToday = startOptions('today', nowMs).length > 0;

  useEffect(() => {
    if (selectedIndex >= 0) listRef.current?.scrollToIndex({ index: selectedIndex, viewPosition: 0.5, animated: false });
  }, [selectedIndex, draft.day]);

  return (
    <View style={styles.root}>
      <Text style={{ color: p.text }}>{t('booking.form.day')}</Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {hasToday ? (
          <Chip label={t('booking.form.today')} selected={draft.day === 'today'} onPress={() => onChange(selectDay(draft, 'today', nowMs))} />
        ) : null}
        <Chip label={t('booking.form.tomorrow')} selected={draft.day === 'tomorrow'} onPress={() => onChange(selectDay(draft, 'tomorrow', nowMs))} />
      </View>

      <Text style={{ color: p.text }}>{t('booking.form.start')}</Text>
      <FlatList
        ref={listRef}
        data={options}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(ms) => String(ms)}
        getItemLayout={(_, index) => ({ length: ITEM_WIDTH, offset: ITEM_WIDTH * index, index })}
        onScrollToIndexFailed={() => undefined}
        renderItem={({ item }) => (
          <View style={{ width: ITEM_WIDTH }}>
            <Chip label={formatClock(item)} selected={item === draft.startMs} onPress={() => onChange(selectStart(draft, item))} />
          </View>
        )}
      />

      <Text style={{ color: p.text }}>{t('booking.form.duration')}</Text>
      <View style={styles.stepper}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('booking.form.shorter')}
          onPress={() => onChange(adjustDuration(draft, -STEP_DELTA_MIN))}
          style={[styles.stepButton, { borderColor: p.border, backgroundColor: p.surface }]}
        >
          <Text style={[styles.stepGlyph, { color: p.text }]}>−</Text>
        </Pressable>
        <Text accessibilityLiveRegion="polite" style={[styles.duration, { color: p.text }]}>
          {formatDuration(duration * 60, lang)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('booking.form.longer')}
          onPress={() => onChange(adjustDuration(draft, STEP_DELTA_MIN))}
          style={[styles.stepButton, { borderColor: p.border, backgroundColor: p.surface }]}
        >
          <Text style={[styles.stepGlyph, { color: p.text }]}>+</Text>
        </Pressable>
      </View>
      <View style={styles.row} accessibilityRole="radiogroup">
        {QUICK_DURATIONS_MIN.map((minutes) => (
          <Chip
            key={minutes}
            label={t('booking.form.quickHours', { count: minutes / 60 })}
            selected={duration === minutes}
            onPress={() => onChange(applyQuickDuration(draft, minutes))}
          />
        ))}
      </View>
      <Text style={[styles.summary, { color: p.text }]}>{whenLabel(draft.startMs, draft.endMs)}</Text>
      {isNotTashkentDevice(nowMs) ? <Text style={{ color: p.textMuted, fontSize: 12 }}>{t('booking.form.tashkentNote')}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  stepButton: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: 24, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepGlyph: { fontSize: 24, fontWeight: '700' },
  duration: { fontSize: 20, fontWeight: '700', minWidth: 96, textAlign: 'center' },
  summary: { fontSize: 16, fontWeight: '700' },
});
