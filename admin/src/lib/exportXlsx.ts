import { strToU8, zipSync } from 'fflate'
import { safeMultiline } from './format'
import { LEADING_BLANKS, XML_ILLEGAL } from './unsafeChars'

// Client-side Excel export. Cells are written as INLINE STRINGS (never <f> formulas), and every
// cell that could still be read as a formula by a spreadsheet (starts with = + - @ TAB or CR,
// even after invisible characters) gets a leading apostrophe, so a hostile plate number or
// review text cannot execute when the file is opened or later converted to CSV.

const FORMULA_START = /^[=+@|%-]/
const PURE_NUMBER = /^-?\d+(\.\d+)?$/
const MAX_CELL_LENGTH = 32_000
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/g
const MAX_SHEET_NAME = 31
const REVOKE_DELAY_MS = 10_000
const ALPHABET_SIZE = 26
const CHAR_CODE_A = 65

/**
 * The text that is written, made safe: controls, bidi and invisible characters are removed first
 * (so a hidden character cannot mask a formula marker), the length is bounded, and a cell whose
 * first visible character is = + - @ | % gets a leading apostrophe. A plain number such as
 * -5000.00 is left alone; +1+1 is not a plain number.
 */
export function sanitizeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value)
  const text = safeMultiline(raw, MAX_CELL_LENGTH).replace(XML_ILLEGAL, '')
  if (PURE_NUMBER.test(text)) return text
  return FORMULA_START.test(text.replace(LEADING_BLANKS, '')) ? `'${text}` : text
}

export interface ExportColumn<T> {
  header: string
  value: (row: T) => unknown
}

export function rowsFromColumns<T>(columns: ExportColumn<T>[], data: T[]): string[][] {
  return [
    columns.map((column) => sanitizeCell(column.header)),
    ...data.map((row) => columns.map((column) => sanitizeCell(column.value(row)))),
  ]
}

export function safeSheetName(name: string): string {
  const cleaned = name.replace(SHEET_NAME_FORBIDDEN, '').slice(0, MAX_SHEET_NAME)
  return cleaned || 'Sheet1'
}

export function columnLetter(index: number): string {
  let n = index
  let letters = ''
  do {
    letters = String.fromCharCode(CHAR_CODE_A + (n % ALPHABET_SIZE)) + letters
    n = Math.floor(n / ALPHABET_SIZE) - 1
  } while (n >= 0)
  return letters
}

function escapeXml(text: string): string {
  return text
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cellXml(text: string, row: number, column: number): string {
  const ref = `${columnLetter(column)}${row + 1}`
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
  return `<c r="${ref}" t="inlineStr"><is><t${preserve}>${escapeXml(text)}</t></is></c>`
}

function sheetXml(rows: string[][]): string {
  const body = rows
    .map(
      (cells, r) => `<row r="${r + 1}">${cells.map((text, c) => cellXml(text, r, c)).join('')}</row>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** The bytes of a one-sheet .xlsx. `rows` must already be sanitised (see rowsFromColumns). */
export function buildXlsx(rows: string[][], sheetName: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_DOC}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_DOC}"><sheets><sheet name="${escapeXml(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_DOC}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml(rows)),
  }
  return zipSync(files)
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const FILENAME_FORBIDDEN = /[^A-Za-z0-9._-]/g

/** Trigger a browser download of the workbook. */
export function downloadXlsx(filename: string, rows: string[][], sheetName: string): void {
  const bytes = buildXlsx(rows, sheetName)
  const blob = new Blob([bytes as BlobPart], { type: XLSX_MIME })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${filename.replace(FILENAME_FORBIDDEN, '_')}.xlsx`
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}
