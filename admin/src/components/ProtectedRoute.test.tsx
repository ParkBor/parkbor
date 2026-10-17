import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthContext, type AuthState, useAuth } from '../lib/auth'
import { anonymousAuth, makeAuth } from '../test/authFixtures'
import { ProtectedRoute } from './ProtectedRoute'

function LoginProbe() {
  const location = useLocation()
  const from = (location.state as { from?: { pathname: string; search: string } } | null)?.from
  return <p>login page from={from ? `${from.pathname}${from.search}` : 'none'}</p>
}

function renderAt(auth: AuthState, path = '/parkings?page=2') {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/parkings" element={<p>secret content</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('ProtectedRoute', () => {
  it('redirects anonymous users to /login and remembers where they wanted to go', () => {
    renderAt(anonymousAuth())
    expect(screen.getByText('login page from=/parkings?page=2')).toBeInTheDocument()
    expect(screen.queryByText('secret content')).toBeNull()
  })

  it('shows a spinner (and no content, no redirect) while the session is being restored', () => {
    renderAt(makeAuth({ status: 'loading' }))
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('secret content')).toBeNull()
    expect(screen.queryByText(/login page/)).toBeNull()
  })

  it('offers a retry (and logout) instead of dropping a session it could not check', async () => {
    const auth = makeAuth({ status: 'unavailable' })
    renderAt(auth)
    expect(screen.getByText('Sessiyani tekshirib bo‘lmadi')).toBeInTheDocument()
    expect(screen.queryByText(/login page/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }))
    expect(auth.retry).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Chiqish' }))
    expect(auth.logout).toHaveBeenCalledTimes(1)
  })

  it.each(['ADMIN', 'OWNER'] as const)('lets %s through', (role) => {
    renderAt(makeAuth({ role }))
    expect(screen.getByText('secret content')).toBeInTheDocument()
  })

  it.each(['DRIVER', 'OPERATOR'] as const)('shows the 403 page for %s', async (role) => {
    const auth = makeAuth({ role })
    renderAt(auth)
    expect(screen.queryByText('secret content')).toBeNull()
    expect(screen.getByText('Ruxsat yo‘q')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Chiqish' }))
    expect(auth.logout).toHaveBeenCalledTimes(1)
  })

  it('treats an authenticated state without a user as forbidden, not as allowed', () => {
    renderAt(makeAuth({ role: null }))
    expect(screen.queryByText('secret content')).toBeNull()
    expect(screen.getByText('Ruxsat yo‘q')).toBeInTheDocument()
  })
})

describe('useAuth', () => {
  it('throws outside an AuthProvider instead of pretending nobody is signed in', () => {
    function Naked() {
      useAuth()
      return null
    }
    const silence = () => undefined
    const original = console.error
    console.error = silence
    try {
      expect(() => render(<Naked />)).toThrow('AuthProvider')
    } finally {
      console.error = original
    }
  })
})
