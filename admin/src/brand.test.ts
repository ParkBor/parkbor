/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en, ru, uz } from './i18n/locales'

const root = resolve(process.cwd()) // vitest runs from admin/
const PNG_SIGNATURE = '89504e470d0a1a0a'
const COLOR_TYPE_OFFSET = 25 // 8 signature + 4 length + 4 'IHDR' + 4 width + 4 height + 1 depth
const RGBA = 6

describe('ParkBor CRM branding', () => {
  it('names the panel in every language', () => {
    for (const locale of [uz, ru, en]) expect(locale.app.title).toBe('ParkBor CRM')
  })

  it('sets the page title, icons and theme colour in index.html', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8')
    expect(html).toContain('<title>ParkBor CRM</title>')
    expect(html).toContain('href="/favicon.svg"')
    expect(html).toContain('rel="apple-touch-icon"')
    expect(html).toContain('content="#0056B4"')
    expect(html).not.toMatch(/habi/i)
  })

  const WIDTH_OFFSET = 16
  const HEIGHT_OFFSET = 20
  const size = (bytes: Buffer) => [bytes.readUInt32BE(WIDTH_OFFSET), bytes.readUInt32BE(HEIGHT_OFFSET)]

  it.each([
    ['parkbor-logo.png', 640, undefined],
    ['parkbor-mark.png', 256, 256],
    ['favicon.png', 64, 64],
  ])('%s is a transparent PNG (alpha channel) of the expected size', (file, width, height) => {
    const bytes = readFileSync(resolve(root, 'public', file))
    expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)
    expect(bytes[COLOR_TYPE_OFFSET]).toBe(RGBA)
    const [w, h] = size(bytes)
    expect(w).toBe(width)
    if (height) expect(h).toBe(height)
    else expect(w / h).toBeGreaterThan(2.8) // pin + wordmark banner, about 3:1
  })

  it('apple-touch-icon is a 180x180 opaque PNG and og-image is 1200x630', () => {
    const icon = readFileSync(resolve(root, 'public', 'apple-touch-icon.png'))
    expect(size(icon)).toEqual([180, 180])
    expect(icon[COLOR_TYPE_OFFSET]).not.toBe(RGBA) // on white, no alpha
    expect(size(readFileSync(resolve(root, 'public', 'og-image.png')))).toEqual([1200, 630])
  })

  it('ships the other icon files', () => {
    for (const file of ['favicon.svg']) {
      expect(existsSync(resolve(root, 'public', file))).toBe(true)
    }
    expect(readFileSync(resolve(root, 'public', 'favicon.svg'), 'utf8')).toContain('ParkBor CRM')
  })

  it('has no user-visible "Habi" left in the panel texts', () => {
    const texts = JSON.stringify([uz, ru, en])
    expect(texts).not.toMatch(/Habi/)
  })
})
