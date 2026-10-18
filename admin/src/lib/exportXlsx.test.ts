import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildXlsx,
  columnLetter,
  downloadXlsx,
  rowsFromColumns,
  safeSheetName,
  sanitizeCell,
} from './exportXlsx'

const ch = (...codes: number[]) => String.fromCodePoint(...codes)

function sheetXml(bytes: Uint8Array): string {
  return strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml'])
}

describe('sanitizeCell (formula injection)', () => {
  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', '=HYPERLINK("http://x")', '|calc', '%x'])(
    'prefixes %j with an apostrophe',
    (value) => {
      expect(sanitizeCell(value)).toBe(`'${value}`)
    },
  )

  it('prefixes a formula hidden behind controls, whitespace or invisible characters', () => {
    expect(sanitizeCell(`${ch(1)}=1`)).toBe("'=1")
    expect(sanitizeCell(`${ch(0x0b)}@x`)).toBe("'@x")
    expect(sanitizeCell(' =1')).toBe("' =1")
    expect(sanitizeCell(' +1')).toBe("' +1")
    expect(sanitizeCell('\n=1')).toBe("'\n=1")
    expect(sanitizeCell(`${ch(0x00a0)}=1`)).toBe(`'${ch(0x00a0)}=1`)
    expect(sanitizeCell(`${ch(0x2003)}=1`)).toBe(`'${ch(0x2003)}=1`)
    expect(sanitizeCell(`${ch(0x3000)}=1`)).toBe(`'${ch(0x3000)}=1`)
    expect(sanitizeCell(`${ch(0x00ad)}=1`)).toBe(`'${ch(0x00ad)}=1`)
    expect(sanitizeCell(`${ch(0x2800)}=1`)).toBe(`'${ch(0x2800)}=1`)
    expect(sanitizeCell(`${ch(0x200b)}=1+1`)).toBe("'=1+1")
    expect(sanitizeCell(`${ch(0x202e)}@x`)).toBe("'@x")
  })

  it('leaves safe values and plain numbers alone', () => {
    expect(sanitizeCell('01A123BC')).toBe('01A123BC')
    expect(sanitizeCell('a=b')).toBe('a=b')
    expect(sanitizeCell('12000.00')).toBe('12000.00')
    expect(sanitizeCell('-5000.00')).toBe('-5000.00')
    expect(sanitizeCell('-5')).toBe('-5')
    expect(sanitizeCell(7)).toBe('7')
  })

  it('does not treat near-numbers as numbers', () => {
    expect(sanitizeCell('-5000.00.1')).toBe("'-5000.00.1")
    expect(sanitizeCell('-')).toBe("'-")
    expect(sanitizeCell('-1e5')).toBe("'-1e5")
  })

  it('turns null, undefined and booleans into text', () => {
    expect(sanitizeCell(null)).toBe('')
    expect(sanitizeCell(undefined)).toBe('')
    expect(sanitizeCell(true)).toBe('true')
  })

  it('removes characters that are illegal in XML before the check', () => {
    expect(sanitizeCell(`a${ch(1)}b${ch(0x0b)}c`)).toBe('abc')
  })

  it('bounds very long strings', () => {
    const out = sanitizeCell('x'.repeat(40_000))
    expect(Array.from(out)).toHaveLength(32_001)
    expect(out.endsWith('…')).toBe(true)
  })

  it('writes objects as inert JSON text, still sanitised', () => {
    expect(sanitizeCell({ a: 1 })).toBe('{"a":1}')
  })
})

describe('rowsFromColumns', () => {
  it('builds a header row and sanitised data rows', () => {
    const rows = rowsFromColumns(
      [
        { header: 'Plate', value: (r: { plate: string }) => r.plate },
        { header: '=Amount', value: () => 7 },
      ],
      [{ plate: '=cmd|calc' }],
    )
    expect(rows).toEqual([
      ['Plate', "'=Amount"],
      ["'=cmd|calc", '7'],
    ])
  })
})

describe('buildXlsx', () => {
  it('produces a zip with the parts of a minimal workbook', () => {
    const parts = unzipSync(buildXlsx([['a']], 'Sheet'))
    expect(Object.keys(parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ])
  })

  it('stores text as inline strings, never as formulas, and escapes XML', () => {
    const xml = sheetXml(buildXlsx([["'=1+1", '<b>&"x"</b>']], 'S'))
    expect(xml).toContain('t="inlineStr"')
    expect(xml).not.toContain('<f>')
    expect(xml).toContain('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;')
    expect(xml).toContain("'=1+1")
  })

  it('drops characters that are illegal in XML 1.0', () => {
    expect(sheetXml(buildXlsx([[`a${ch(1)}b${ch(0x0b)}c`]], 'S'))).toContain('abc')
  })

  it('preserves leading and trailing spaces', () => {
    expect(sheetXml(buildXlsx([['  x ']], 'S'))).toContain('xml:space="preserve"')
  })

  it('addresses cells A1.. with correct column letters', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(701)).toBe('ZZ')
    expect(columnLetter(702)).toBe('AAA')
    const xml = sheetXml(buildXlsx([['a', 'b'], ['c']], 'S'))
    expect(xml).toContain('r="A1"')
    expect(xml).toContain('r="B1"')
    expect(xml).toContain('r="A2"')
  })

  it('handles an empty table and 5k rows', () => {
    expect(() => buildXlsx([], 'S')).not.toThrow()
    const rows = Array.from({ length: 5000 }, (_, i) => [String(i), 'x'])
    expect(sheetXml(buildXlsx(rows, 'S'))).toContain('r="A5000"')
  })
})

describe('safeSheetName', () => {
  it('removes forbidden characters and limits the length to 31', () => {
    expect(safeSheetName('a[b]:c*d?e/f\\g')).toBe('abcdefg')
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31)
    expect(safeSheetName('')).toBe('Sheet1')
  })
})

describe('downloadXlsx', () => {
  afterEach(() => vi.useRealTimers())

  it('revokes the object URL only after a delay and cleans the file name', () => {
    vi.useFakeTimers()
    const create = vi.fn(() => 'blob:x')
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    downloadXlsx('my report/../x', [['a']], 'S')
    expect(click).toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(revoke).toHaveBeenCalledWith('blob:x')
    click.mockRestore()
    vi.unstubAllGlobals()
  })
})
