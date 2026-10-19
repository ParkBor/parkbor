import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isChunkLoadError } from '../lib/chunkError'
import { ErrorBoundary } from './ErrorBoundary'

function Boom({ message }: { message: string }): never {
  throw new Error(message)
}

afterEach(() => vi.restoreAllMocks())

describe('isChunkLoadError', () => {
  it('recognises failed dynamic imports', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /a.js'))).toBe(true)
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true)
    expect(isChunkLoadError(new Error('boom'))).toBe(false)
    expect(isChunkLoadError('text')).toBe(false)
  })
})

describe('ErrorBoundary', () => {
  it('renders children when nothing fails', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('fine')).toBeInTheDocument()
  })

  it('shows a recoverable error screen without leaking the message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    function Toggle() {
      const [broken, setBroken] = useState(true)
      return (
        <ErrorBoundary>
          {broken ? <Boom message="secret internals" /> : <p>recovered</p>}
          <button onClick={() => setBroken(false)}>fix</button>
        </ErrorBoundary>
      )
    }
    render(<Toggle />)
    expect(await screen.findByText('Kutilmagan xatolik')).toBeInTheDocument()
    expect(screen.queryByText(/secret internals/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Sahifani yangilash' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Qayta urinish' })).toBeInTheDocument()
  })

  it('asks for a reload after a failed chunk and offers no in-place retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <Boom message="Failed to fetch dynamically imported module: /x.js" />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Ilova yangilangan')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Qayta urinish' })).toBeNull()
  })

  it('clears the error when the reset key changes (navigation)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Boom message="x" />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Kutilmagan xatolik')).toBeInTheDocument()
    rerender(
      <ErrorBoundary resetKey="/b">
        <p>next page</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('next page')).toBeInTheDocument()
    await userEvent.setup()
  })
})
