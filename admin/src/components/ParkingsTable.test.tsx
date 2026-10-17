import type { ParkingLot } from '@habi/api-client'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { moderationActionsFor } from '../lib/moderation'
import { ParkingsTable } from './ParkingsTable'

function lot(overrides: Partial<ParkingLot> = {}): ParkingLot {
  return {
    id: 'id-1',
    owner: 'owner-1',
    name: 'Chilonzor P1',
    address: 'Chilonzor 7',
    location: { lat: 41.27, lng: 69.2 },
    area: null,
    status: 'PENDING_REVIEW',
    open_time: null,
    close_time: null,
    total_slots: 50,
    free_slots: 12,
    rating: 4.5,
    created_at: '2026-10-15T10:00:00Z',
    ...overrides,
  }
}

const baseProps = { total: 1, page: 1, pageSize: 20, onPageChange: vi.fn(), onEdit: vi.fn() }

describe('ParkingsTable', () => {
  it('renders rows with translated status and free/total slots', () => {
    render(<ParkingsTable {...baseProps} rows={[lot()]} />)
    expect(screen.getByText('Chilonzor P1')).toBeInTheDocument()
    expect(screen.getByText('Ko‘rib chiqilmoqda')).toBeInTheDocument()
    expect(screen.getByText('12/50')).toBeInTheDocument()
  })

  it('shows the empty state without rows', () => {
    render(<ParkingsTable {...baseProps} total={0} rows={[]} />)
    expect(screen.queryByText('Chilonzor P1')).not.toBeInTheDocument()
    expect(document.querySelector('.ant-empty')).not.toBeNull()
  })

  it('requests the next page from the server instead of slicing locally', async () => {
    const onPageChange = vi.fn()
    render(
      <ParkingsTable {...baseProps} total={45} rows={[lot()]} onPageChange={onPageChange} />,
    )
    await userEvent.click(screen.getByTitle('2'))
    expect(onPageChange).toHaveBeenCalledWith(2, 20)
  })

  it('calls onEdit with the row id', async () => {
    const onEdit = vi.fn()
    render(<ParkingsTable {...baseProps} rows={[lot()]} onEdit={onEdit} />)
    await userEvent.click(screen.getByRole('button', { name: 'Tahrirlash' }))
    expect(onEdit).toHaveBeenCalledWith('id-1')
  })

  it('hides moderation buttons unless allowed', () => {
    render(<ParkingsTable {...baseProps} rows={[lot()]} onModerate={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Tasdiqlash' })).not.toBeInTheDocument()
  })

  it('lets an admin approve a pending lot', async () => {
    const onModerate = vi.fn()
    render(<ParkingsTable {...baseProps} rows={[lot()]} canModerate onModerate={onModerate} />)
    const row = screen.getByText('Chilonzor P1').closest('tr') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: 'Tasdiqlash' }))
    expect(onModerate).toHaveBeenCalledWith('id-1', 'approve')
  })
})

describe('moderationActionsFor', () => {
  it('maps status to the allowed actions', () => {
    expect(moderationActionsFor('PENDING_REVIEW')).toEqual(['approve', 'suspend'])
    expect(moderationActionsFor('ACTIVE')).toEqual(['suspend'])
    expect(moderationActionsFor('SUSPENDED')).toEqual(['restore'])
  })
})
