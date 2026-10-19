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

  it.each(['parkbor-logo.png', 'parkbor-mark.png', 'favicon.png'])(
    '%s is a PNG with an alpha channel (transparent background)',
    (file) => {
      const bytes = readFileSync(resolve(root, 'public', file))
      expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)
      expect(bytes[COLOR_TYPE_OFFSET]).toBe(RGBA)
    },
  )

  it('ships the other icon files', () => {
    for (const file of ['favicon.svg', 'apple-touch-icon.png']) {
      expect(existsSync(resolve(root, 'public', file))).toBe(true)
    }
    expect(readFileSync(resolve(root, 'public', 'favicon.svg'), 'utf8')).toContain('ParkBor CRM')
  })

  it('has no user-visible "Habi" left in the panel texts', () => {
    const texts = JSON.stringify([uz, ru, en])
    expect(texts).not.toMatch(/Habi/)
  })
})
