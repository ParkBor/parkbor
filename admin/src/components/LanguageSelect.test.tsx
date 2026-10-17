import { render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { LanguageSelect } from './LanguageSelect'

afterEach(async () => {
  await act(() => i18n.changeLanguage('uz'))
})

describe('LanguageSelect', () => {
  it.each([
    ['uz', 'Til'],
    ['ru', 'Язык'],
    ['en', 'Language'],
  ])('labels the control in %s', async (lng, label) => {
    await act(() => i18n.changeLanguage(lng))
    render(<LanguageSelect />)
    expect(screen.getByRole('combobox', { name: label })).toBeInTheDocument()
  })
})
