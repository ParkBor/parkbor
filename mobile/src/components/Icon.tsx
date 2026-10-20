import type { ColorValue } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

export type IconName = 'chevron-back' | 'map' | 'ticket' | 'user' | 'shield' | 'close';

// 24x24 outline glyphs drawn with react-native-svg (already a dependency): crisp at any size and font
// scale, coloured by the palette, no emoji (those render differently per vendor and per OS version).
const PATHS: Record<IconName, string[]> = {
  'chevron-back': ['M15 5l-7 7 7 7'],
  map: ['M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z', 'M9 4v14', 'M15 6v14'],
  ticket: ['M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4z', 'M14 7v10'],
  user: ['M4 21c0-4 4-6 8-6s8 2 8 6'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M8.5 12l2.5 2.5 5-5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
};

interface IconProps {
  name: IconName;
  color: ColorValue;
  size?: number;
}

/** Decorative: the control that contains it carries the accessibility label. */
export function Icon({ name, color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      {PATHS[name].map((d) => (
        <Path key={d} d={d} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {name === 'user' ? <Circle cx={12} cy={8} r={4} stroke={color} strokeWidth={2} /> : null}
    </Svg>
  );
}
