import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { LocaleConfig } from './LocaleConfig'

afterEach(async () => {
  await i18n.changeLanguage('uz')
})

describe('LocaleConfig', () => {
  it('sets <html lang> and follows language changes', async () => {
    render(
      <LocaleConfig>
        <p>content</p>
      </LocaleConfig>,
    )
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('uz')
    await act(() => i18n.changeLanguage('ru'))
    expect(document.documentElement.lang).toBe('ru')
    await act(() => i18n.changeLanguage('en'))
    expect(document.documentElement.lang).toBe('en')
  })
})
