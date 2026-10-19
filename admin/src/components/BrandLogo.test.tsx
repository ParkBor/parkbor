import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandLogo } from './BrandLogo'

describe('BrandLogo', () => {
  it('shows the full logo with the product name as its accessible text', () => {
    render(<BrandLogo />)
    const img = screen.getByAltText('ParkBor CRM')
    expect(img).toHaveAttribute('src', '/parkbor-logo.png')
  })

  it('shows only the mark in the compact variant, as a square', () => {
    render(<BrandLogo variant="mark" height={32} />)
    const img = screen.getByAltText('ParkBor CRM')
    expect(img).toHaveAttribute('src', '/parkbor-mark.png')
    expect(img).toHaveAttribute('width', '32')
    expect(img).toHaveAttribute('height', '32')
  })

  it('is decorative (empty alt) next to a visible name', () => {
    const { container } = render(<BrandLogo decorative />)
    expect(container.querySelector('img')).toHaveAttribute('alt', '')
  })
})
