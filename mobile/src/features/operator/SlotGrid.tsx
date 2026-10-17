import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MapSlot } from '@/features/operator/operatorSchemas';
import { slotToneColors } from '@/features/operator/slotColors';
import { groupSlots, kindVisual, slotCounts, slotVisual, SLOT_KINDS } from '@/features/operator/slotView';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface SlotGridProps {
  slots: readonly MapSlot[];
  onSelect: (slot: MapSlot) => void;
}

/** Floor -> zone -> cells. One cell = code + glyph + coloured border; the state is also in the a11y label. */
export function SlotGrid({ slots, onSelect }: SlotGridProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const groups = useMemo(() => groupSlots(slots), [slots]);
  return (
    <View style={styles.root}>
      {groups.map((floor) => (
        <View key={floor.floor} style={styles.floor}>
          <Text accessibilityRole="header" style={[styles.floorTitle, { color: p.text }]}>
            {t('operator.slots.floor', { floor: floor.floor })}
          </Text>
          {floor.zones.map((zone) => (
            <View key={zone.zone} style={styles.zone}>
              <Text style={{ color: p.textMuted, fontWeight: '600' }}>{t('operator.slots.zone', { zone: zone.zone })}</Text>
              <View style={styles.cells}>
                {zone.slots.map((slot) => {
                  const visual = slotVisual(slot);
                  const colors = slotToneColors(visual.tone, p);
                  const label = t(visual.labelKey);
                  return (
                    <Pressable
                      key={slot.id}
                      accessibilityRole="button"
                      accessibilityLabel={t('operator.slots.cell', { code: slot.code, state: label })}
                      onPress={() => onSelect(slot)}
                      style={[styles.cell, { borderColor: colors.border, backgroundColor: p.surface }]}
                    >
                      <Text style={[styles.glyph, { color: colors.text }]}>{visual.glyph}</Text>
                      <Text style={[styles.code, { color: p.text }]} numberOfLines={1}>
                        {slot.code}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** Legend with counts: glyph + word + number for each state. */
export function SlotLegend({ slots }: { slots: readonly MapSlot[] }) {
  const { t } = useTranslation();
  const p = usePalette();
  const counts = useMemo(() => slotCounts(slots), [slots]);
  return (
    <View accessibilityLabel={t('operator.slots.legend')} style={styles.legend}>
      {SLOT_KINDS.filter((kind) => kind !== 'unknown' || counts.unknown > 0).map((kind) => {
        const visual = kindVisual(kind);
        const colors = slotToneColors(visual.tone, p);
        return (
          <Text key={kind} style={{ color: p.text }}>
            <Text style={{ color: colors.text, fontWeight: '800' }}>{visual.glyph}</Text> {t(visual.labelKey)} {counts[kind]}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 16 },
  floor: { gap: 8 },
  floorTitle: { fontSize: 18, fontWeight: '700' },
  zone: { gap: 6 },
  cells: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { minWidth: 72, minHeight: MIN_TOUCH + 8, borderWidth: 3, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  glyph: { fontSize: 18, fontWeight: '800' },
  code: { fontSize: 14, fontWeight: '700' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
});
