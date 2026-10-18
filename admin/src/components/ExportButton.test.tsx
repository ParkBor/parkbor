import { PaginationLimitError } from '../lib/fetchAll'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const download = vi.hoisted(() => vi.fn())
vi.mock('../lib/exportXlsx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/exportXlsx')>()),
  downloadXlsx: download,
}))

import { AuthContext } from '../lib/auth'
import { makeAuth } from '../test/authFixtures'
import { ExportButton } from './ExportButton'

const columns = [
  { header: 'Plate', value: (r: { plate: string }) => r.plate },
  { header: 'Amount', value: () => '-5.00' },
]

function renderButton(loadRows: () => Promise<{ plate: string }[]>, role: 'ADMIN' | 'DRIVER' = 'ADMIN') {
  return render(
    <AuthContext.Provider value={makeAuth({ role })}>
      <ExportButton filename="bookings" columns={columns} loadRows={loadRows} />
    </AuthContext.Provider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('ExportButton', () => {
  it('exports every row with formula-safe cells', async () => {
    renderButton(async () => [{ plate: '=cmd|calc' }, { plate: '@SUM(1)' }, { plate: '01A123BC' }])
    await userEvent.click(screen.getByRole('button', { name: 'Excelga yuklash' }))
    await waitFor(() => expect(download).toHaveBeenCalled())
    const [name, rows] = download.mock.calls[0]
    expect(name).toBe('bookings')
    expect(rows).toEqual([
      ['Plate', 'Amount'],
      ["'=cmd|calc", '-5.00'],
      ["'@SUM(1)", '-5.00'],
      ['01A123BC', '-5.00'],
    ])
  })

  it('tells the user when the result is too large and downloads nothing', async () => {
    renderButton(async () => {
      throw new PaginationLimitError()
    })
    await userEvent.click(screen.getByRole('button', { name: 'Excelga yuklash' }))
    expect(await screen.findByText('Qatorlar juda ko‘p. Filtrni toraytiring.')).toBeInTheDocument()
    expect(download).not.toHaveBeenCalled()
  })

  it('reports a failed load', async () => {
    renderButton(async () => {
      throw new Error('boom')
    })
    await userEvent.click(screen.getByRole('button', { name: 'Excelga yuklash' }))
    expect(await screen.findByText('Eksport amalga oshmadi')).toBeInTheDocument()
  })

  it('is not rendered for roles without the export right', () => {
    renderButton(async () => [], 'DRIVER')
    expect(screen.queryByRole('button', { name: 'Excelga yuklash' })).toBeNull()
  })
})
