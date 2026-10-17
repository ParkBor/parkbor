import type { Cardinal } from '@/features/route/routeProgress';
import { INSTRUCTION_KEYS, type InstructionKey } from '@/features/route/routeSchemas';
import type { Language } from '@/lib/types';

export const MAX_STREET_NAME_LENGTH = 60;

export interface StepForText {
  key: InstructionKey;
  name: string;
  roundaboutExit: number | null;
}

type Texts = Readonly<Record<InstructionKey, string>>;

interface LanguageTexts {
  texts: Texts;
  /** Roundabout with a known exit; `{exit}` is replaced by the number. */
  roundaboutExit: string;
  compass: Readonly<Record<Cardinal, string>>;
}

// Instruction wording is locale data kept next to the logic (like format.ts), so every key in
// every language is covered by a plain unit test without an i18n runtime.
const TEXTS: Readonly<Record<Language, LanguageTexts>> = {
  uz: {
    texts: {
      depart: 'Yo‘lga chiqing',
      arrive: 'Manzilga yetdingiz',
      turn_left: 'Chapga buriling',
      turn_right: 'O‘ngga buriling',
      slight_left: 'Biroz chapga buriling',
      slight_right: 'Biroz o‘ngga buriling',
      sharp_left: 'Keskin chapga buriling',
      sharp_right: 'Keskin o‘ngga buriling',
      straight: 'To‘g‘ri yuring',
      uturn: 'Orqaga qayriling',
      roundabout: 'Aylanmaga kiring',
      merge: 'Oqimga qo‘shiling',
      merge_left: 'Chap tomonga qo‘shiling',
      merge_right: 'O‘ng tomonga qo‘shiling',
      fork: 'Ayrilishda yo‘nalishni tanlang',
      fork_left: 'Ayrilishda chapda qoling',
      fork_right: 'Ayrilishda o‘ngda qoling',
      ramp: 'Qo‘shimcha yo‘lga chiqing',
      ramp_left: 'Chapdagi qo‘shimcha yo‘lga chiqing',
      ramp_right: 'O‘ngdagi qo‘shimcha yo‘lga chiqing',
      continue: 'Davom eting',
      other: 'Yo‘lda davom eting',
    },
    roundaboutExit: 'Aylanmadan {exit}-chiqishga chiqing',
    compass: {
      n: 'shimol', ne: 'shimoli-sharq', e: 'sharq', se: 'janubi-sharq',
      s: 'janub', sw: 'janubi-g‘arb', w: 'g‘arb', nw: 'shimoli-g‘arb',
    },
  },
  ru: {
    texts: {
      depart: 'Начните движение',
      arrive: 'Вы прибыли',
      turn_left: 'Поверните налево',
      turn_right: 'Поверните направо',
      slight_left: 'Возьмите левее',
      slight_right: 'Возьмите правее',
      sharp_left: 'Резко налево',
      sharp_right: 'Резко направо',
      straight: 'Езжайте прямо',
      uturn: 'Развернитесь',
      roundabout: 'Въезжайте на кольцо',
      merge: 'Вливайтесь в поток',
      merge_left: 'Перестройтесь влево',
      merge_right: 'Перестройтесь вправо',
      fork: 'На развилке выберите путь',
      fork_left: 'На развилке держитесь левее',
      fork_right: 'На развилке держитесь правее',
      ramp: 'Съезжайте на примыкающую дорогу',
      ramp_left: 'Съезжайте на дорогу слева',
      ramp_right: 'Съезжайте на дорогу справа',
      continue: 'Продолжайте движение',
      other: 'Следуйте по маршруту',
    },
    roundaboutExit: 'На кольце выберите {exit}-й съезд',
    compass: {
      n: 'север', ne: 'северо-восток', e: 'восток', se: 'юго-восток',
      s: 'юг', sw: 'юго-запад', w: 'запад', nw: 'северо-запад',
    },
  },
  en: {
    texts: {
      depart: 'Head out',
      arrive: 'You have arrived',
      turn_left: 'Turn left',
      turn_right: 'Turn right',
      slight_left: 'Bear left',
      slight_right: 'Bear right',
      sharp_left: 'Turn sharp left',
      sharp_right: 'Turn sharp right',
      straight: 'Go straight',
      uturn: 'Make a U-turn',
      roundabout: 'Enter the roundabout',
      merge: 'Merge',
      merge_left: 'Merge left',
      merge_right: 'Merge right',
      fork: 'At the fork, choose your way',
      fork_left: 'At the fork, keep left',
      fork_right: 'At the fork, keep right',
      ramp: 'Take the ramp',
      ramp_left: 'Take the ramp on the left',
      ramp_right: 'Take the ramp on the right',
      continue: 'Continue',
      other: 'Follow the route',
    },
    roundaboutExit: 'Take exit {exit} at the roundabout',
    compass: {
      n: 'north', ne: 'northeast', e: 'east', se: 'southeast',
      s: 'south', sw: 'southwest', w: 'west', nw: 'northwest',
    },
  },
};

const KNOWN: ReadonlySet<string> = new Set(INSTRUCTION_KEYS);

// Every Unicode "other" category (Cc controls, Cf format such as zero-width/bidi/soft hyphen/
// tag characters, Cs, Co, Cn), like the backend; tabs/newlines are turned into spaces first.
const INVISIBLE = new RegExp(String.raw`\p{C}`, 'gu');
const LINE_BREAKS = new RegExp(String.raw`[\t\n\r\v\f\u2028\u2029]`, 'g');

/**
 * Street names come from the network (OSM): drop control/invisible characters, collapse
 * whitespace and cap the length. The result is only ever shown through a plain <Text>, never as
 * HTML or markup, so characters like "<" stay inert.
 */
export function sanitizeStreetName(raw: string): string {
  if (typeof raw !== 'string') return '';
  // Real whitespace (incl. tabs/newlines) becomes one space; other invisible characters vanish.
  const text = raw
    .replace(LINE_BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  if (chars.length <= MAX_STREET_NAME_LENGTH) return text;
  return `${chars.slice(0, MAX_STREET_NAME_LENGTH - 1).join('').trimEnd()}…`;
}

export interface InstructionText {
  /** Main line, e.g. "Turn left". */
  text: string;
  /** Sanitized street name, or null. */
  street: string | null;
}

export function describeInstruction(step: StepForText, lang: Language): InstructionText {
  const catalog = TEXTS[lang];
  const key: InstructionKey = KNOWN.has(step.key) ? step.key : 'other';
  const text =
    key === 'roundabout' && step.roundaboutExit !== null
      ? catalog.roundaboutExit.replace('{exit}', String(step.roundaboutExit))
      : catalog.texts[key];
  return { text, street: sanitizeStreetName(step.name) || null };
}

export function compassText(direction: Cardinal, lang: Language): string {
  return TEXTS[lang].compass[direction];
}
