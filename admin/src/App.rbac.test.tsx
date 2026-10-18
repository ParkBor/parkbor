import type { UserRole } from '@habi/api-client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./pages/DashboardPage', () => ({ default: () => <p>dashboard page</p> }))
vi.mock('./pages/SettingsPage', () => ({ default: () => <p>settings page</p> }))
vi.mock('./pages/AuditLogPage', () => ({ default: () => <p>audit page</p> }))
vi.mock('./pages/UsersPage', () => ({ default: () => <p>users page</p> }))
vi.mock('./pages/ModerationPage', () => ({ default: () => <p>moderation page</p> }))
vi.mock('./pages/OperatorsPage', () => ({ default: () => <p>operators page</p> }))

import App from './App'
import { AuthContext } from './lib/auth'
import { makeAuth } from './test/authFixtures'

function renderAt(path: string, role: UserRole) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AuthContext.Provider value={makeAuth({ role })}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

describe('role based routes', () => {
  it.each(['/settings', '/audit', '/users', '/moderation'])(
    'shows OWNER a 403 instead of %s',
    async (path) => {
      renderAt(path, 'OWNER')
      expect(await screen.findByText('Ruxsat yo‘q')).toBeInTheDocument()
      expect(screen.queryByText(/ page$/)).toBeNull()
    },
  )

  it('hides the super admin menu entries from OWNER but keeps the owner ones', async () => {
    renderAt('/dashboard', 'OWNER')
    expect(await screen.findByText('dashboard page')).toBeInTheDocument()
    for (const name of ['Sozlamalar', 'Audit jurnali', 'Foydalanuvchilar', 'Moderatsiya']) {
      expect(screen.queryByRole('menuitem', { name })).toBeNull()
    }
    for (const name of ['Bronlar', 'Operatorlar', 'To‘lovlar', 'Qaytarishlar']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
    }
  })

  it('lets ADMIN into every section', async () => {
    renderAt('/settings', 'ADMIN')
    expect(await screen.findByText('settings page')).toBeInTheDocument()
    for (const name of ['Sozlamalar', 'Audit jurnali', 'Foydalanuvchilar', 'Moderatsiya']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
    }
  })

  it('sends the root and unknown paths to the dashboard', async () => {
    renderAt('/no/such/page', 'ADMIN')
    expect(await screen.findByText('dashboard page')).toBeInTheDocument()
  })
})
