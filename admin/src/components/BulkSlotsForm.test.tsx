import type { Zone } from '@habi/api-client'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BulkSlotsForm } from './BulkSlotsForm'

const zones: Zone[] = [
  { id: 'zone-a', parking_lot: 'lot-1', name: 'A', floor: 0, created_at: '2026-10-15T10:00:00Z' },
]

describe('BulkSlotsForm', () => {
  it('submits "zone A, 1-50" by default', async () => {
    const onSubmit = vi.fn()
    render(<BulkSlotsForm zones={zones} onSubmit={onSubmit} />)
    await userEvent.click(screen.getByRole('button', { name: 'Slotlarni yaratish' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toEqual({
      zone: 'zone-a',
      prefix: 'A',
      start: 1,
      end: 50,
      type: 'STANDARD',
      distance_to_entrance: 0,
    })
  })

  it('blocks an invalid prefix', async () => {
    const onSubmit = vi.fn()
    render(<BulkSlotsForm zones={zones} onSubmit={onSubmit} />)
    const prefix = screen.getByLabelText('Prefiks (masalan, A)')
    await userEvent.clear(prefix)
    await userEvent.type(prefix, 'A-1')
    await userEvent.click(screen.getByRole('button', { name: 'Slotlarni yaratish' }))
    expect(await screen.findByText('Faqat harf va raqam (1–10 belgi)')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('blocks end smaller than start', async () => {
    const onSubmit = vi.fn()
    render(<BulkSlotsForm zones={zones} onSubmit={onSubmit} />)
    const end = screen.getByLabelText('Tugash')
    await userEvent.clear(end)
    await userEvent.type(end, '0')
    await userEvent.click(screen.getByRole('button', { name: 'Slotlarni yaratish' }))
    expect(await screen.findByText('Boshlanish kamida 1 bo‘lsin')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('blocks more than 500 slots', async () => {
    const onSubmit = vi.fn()
    render(<BulkSlotsForm zones={zones} onSubmit={onSubmit} />)
    const end = screen.getByLabelText('Tugash')
    await userEvent.clear(end)
    await userEvent.type(end, '501')
    await userEvent.click(screen.getByRole('button', { name: 'Slotlarni yaratish' }))
    expect(await screen.findByText('Bir so‘rovda ko‘pi bilan 500 ta slot')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
