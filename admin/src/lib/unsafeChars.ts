// Character classes built from code points (no raw invisible characters in the source file).

type Range = readonly [number, number]

function classOf(ranges: readonly Range[]): string {
  return ranges
    .map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`)
    .join('')
}

const C0_C1: readonly Range[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
]
// zero-width, direction marks, line/paragraph separators, bidi embeddings/isolates, word joiner
// and the byte order mark: invisible text that can disguise what a value says.
const INVISIBLE: readonly Range[] = [
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
]
// Blank-looking characters a spreadsheet may skip before deciding that a cell is a formula
// (no-break space, soft hyphen, Unicode spaces, ideographic space, braille blank, ...).
const BLANKS: readonly Range[] = [
  [0x00a0, 0x00a0],
  [0x00ad, 0x00ad],
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x2800, 0x2800],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]
// Not allowed in XML 1.0 documents: C0 controls except TAB, LF, CR, and U+FFFE / U+FFFF.
const XML_ILLEGAL_RANGES: readonly Range[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0xfffe, 0xffff],
]

/** Controls plus invisible characters: stripped from every server text before it is shown. */
export const UNSAFE_TEXT = new RegExp(`[${classOf([...C0_C1, ...INVISIBLE])}]`, 'g')
/** Leading invisible characters (they could hide a formula marker from a naive check). */
export const INVISIBLE_PREFIX = new RegExp(`^[${classOf(INVISIBLE)}]+`)
export const XML_ILLEGAL = new RegExp(`[${classOf(XML_ILLEGAL_RANGES)}]`, 'g')
/** Everything that can precede the first visible character of a cell. */
export const LEADING_BLANKS = new RegExp(
  `^[${classOf([[0x20, 0x20], ...C0_C1, ...INVISIBLE, ...BLANKS])}]+`,
)
/** Tabs and line breaks: shown as one space. */
export const LINE_BREAKS = new RegExp(`[${classOf([[9, 10], [13, 13]])}]+`, 'g')
/** Newline kept, other controls dropped (multi-line audit details). */
export const UNSAFE_EXCEPT_NEWLINE = new RegExp(
  `[${classOf([[0x0000, 0x0009], [0x000b, 0x001f], [0x007f, 0x009f], ...INVISIBLE])}]`,
  'g',
)
