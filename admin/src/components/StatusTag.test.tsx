import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusTag } from './StatusTag'

describe('StatusTag', () => {
  it('translates a known value', () => {
    render(<StatusTag kind="booking" value="ACTIVE" />)
    expect(screen.getByText('Faol')).toBeInTheDocument()
  })

  it('shows an unknown value as sanitised text, never as a translation key', () => {
    render(<StatusTag kind="booking" value="status.role.ADMIN" />)
    expect(screen.getByText('status.role.ADMIN')).toBeInTheDocument()
    expect(screen.queryByText('Super admin')).toBeNull()
  })

  it('does not trust prototype keys or odd types', () => {
    render(<StatusTag kind="role" value="constructor" />)
    expect(screen.getByText('constructor')).toBeInTheDocument()
    render(<StatusTag kind="role" value={undefined as never} />)
  })
})
