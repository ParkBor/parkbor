import type { UserRole } from '@habi/api-client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthContext } from '../lib/auth'
import { makeAuth } from './authFixtures'

export function pageOf<T>(results: T[], count = results.length) {
  return { count, next: null, previous: null, results }
}

interface RenderOptions {
  role?: UserRole
  path?: string
  route?: string
}

/** Renders a page inside auth, query and router providers (queries do not retry). */
export function renderPage(element: ReactElement, { role = 'ADMIN', path = '/', route = '/' }: RenderOptions = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AuthContext.Provider value={makeAuth({ role })}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={element} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}
