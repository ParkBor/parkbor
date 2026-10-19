import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from './App'
import { AuthContext, type AuthState } from './lib/auth'
import { anonymousAuth, makeAuth } from './test/authFixtures'

function renderAt(path: string, auth: AuthState = makeAuth()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

describe('App shell', () => {
  it('renders the ParkBor CRM logo and the sidebar menu in Uzbek', async () => {
    renderAt('/tariffs')
    expect(await screen.findByAltText('ParkBor CRM')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Avtoturargohlar' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Zona va slotlar' })).toBeInTheDocument()
    expect(await screen.findByText('Avtoturargohni tanlang')).toBeInTheDocument()
  })

  it('shows the signed-in user and logs out through the header button', async () => {
    const auth = makeAuth()
    renderAt('/tariffs', auth)
    expect(await screen.findByText('Ali')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Chiqish' }))
    expect(auth.logout).toHaveBeenCalledTimes(1)
  })

  it('sends anonymous visitors to the login page instead of the panel', async () => {
    renderAt('/tariffs', anonymousAuth())
    expect(await screen.findByText('Telegram hisobingiz orqali kiring')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Tariflar' })).toBeNull()
  })

  it('shows 403 instead of the panel for non-staff roles', async () => {
    renderAt('/tariffs', makeAuth({ role: 'DRIVER' }))
    expect(await screen.findByText('Ruxsat yo‘q')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Tariflar' })).toBeNull()
  })

  it('redirects a signed-in user away from /login to the panel', async () => {
    renderAt('/login')
    expect(await screen.findByRole('menuitem', { name: 'Avtoturargohlar' })).toBeInTheDocument()
    expect(screen.queryByText('Telegram hisobingiz orqali kiring')).toBeNull()
  })
})
