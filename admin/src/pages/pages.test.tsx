import { ApiError } from '@habi/api-client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  parkings: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn() },
  zones: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
  slots: { list: vi.fn(), bulk: vi.fn() },
  tariffs: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
}))
vi.mock('../lib/api', () => ({ adminApi: api, setAccessToken: vi.fn() }))
vi.mock('../components/MapPicker', () => ({ MapPicker: () => null }))

import { AuthContext } from '../lib/auth'
import { makeAuth } from '../test/authFixtures'
import ParkingEditPage from './ParkingEditPage'
import ParkingsListPage from './ParkingsListPage'
import TariffsPage from './TariffsPage'

function renderAt(path: string, element: React.ReactElement, route = path) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AuthContext.Provider value={makeAuth()}>
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

const page = (results: unknown[] = []) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

const loadedLot = {
  id: 'abc',
  owner: 'o',
  name: 'Loaded lot',
  address: 'A',
  location: { lat: 41, lng: 69 },
  area: null,
  status: 'ACTIVE',
  open_time: null,
  close_time: null,
  total_slots: 0,
  free_slots: 0,
  rating: 0,
  created_at: '',
}

beforeEach(() => {
  vi.clearAllMocks()
  api.parkings.list.mockResolvedValue(page())
})

describe('ParkingEditPage', () => {
  it('never requests a lot for a malformed id', async () => {
    renderAt('/parkings/..%2Fevil/edit', <ParkingEditPage />, '/parkings/:id/edit')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(api.parkings.get).not.toHaveBeenCalled()
  })

  it('shows a not-found state instead of an empty "new" form', async () => {
    api.parkings.get.mockRejectedValue(new ApiError(404, { detail: 'Not found.' }, 'http'))
    renderAt('/parkings/123e4567-e89b-12d3-a456-426614174000/edit', <ParkingEditPage />, '/parkings/:id/edit')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('offers a retry on a server failure and recovers', async () => {
    api.parkings.get
      .mockRejectedValueOnce(new ApiError(502, null, 'http'))
      .mockResolvedValueOnce(loadedLot)
    renderAt('/parkings/123e4567-e89b-12d3-a456-426614174000/edit', <ParkingEditPage />, '/parkings/:id/edit')
    await userEvent.click(await screen.findByRole('button', { name: 'Qayta urinish' }))
    expect(await screen.findByDisplayValue('Loaded lot')).toBeInTheDocument()
  })
})

describe('list pages show query errors', () => {
  it('ParkingsListPage: alert with retry', async () => {
    api.parkings.list.mockRejectedValueOnce(new ApiError(0, 'Failed to fetch', 'network'))
    renderAt('/parkings', <ParkingsListPage />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    api.parkings.list.mockResolvedValueOnce(page())
    await userEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('TariffsPage: parking select failure is visible', async () => {
    api.parkings.list.mockRejectedValue(new ApiError(500, null, 'http'))
    renderAt('/tariffs', <TariffsPage />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

describe('ParkingSelect', () => {
  it('searches on the server instead of truncating at 100 rows', async () => {
    renderAt('/tariffs', <TariffsPage />)
    await waitFor(() => expect(api.parkings.list).toHaveBeenCalled())
    await userEvent.type(screen.getByRole('combobox'), 'Chil')
    await waitFor(() =>
      expect(api.parkings.list).toHaveBeenCalledWith(expect.objectContaining({ search: 'Chil' })),
    )
  })
})
