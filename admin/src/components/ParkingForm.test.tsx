import { ApiError } from '@habi/api-client'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ParkingForm } from './ParkingForm'

// Leaflet needs a real layout engine; replace the map by a button that "clicks" a point.
vi.mock('./MapPicker', () => ({
  MapPicker: ({ onChange }: { onChange: (v: { lat: number; lng: number }) => void }) => (
    <button type="button" onClick={() => onChange({ lat: 41.2755, lng: 69.2034 })}>
      pick-point
    </button>
  ),
}))

describe('ParkingForm', () => {
  it('shows translated validation errors and does not submit an empty form', async () => {
    const onSubmit = vi.fn()
    render(<ParkingForm onSubmit={onSubmit} />)
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    expect(await screen.findAllByText('Majburiy maydon')).not.toHaveLength(0)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('fills lat/lng from the map and submits the values', async () => {
    const onSubmit = vi.fn()
    render(<ParkingForm onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText('Nomi'), 'Chilonzor P1')
    await userEvent.type(screen.getByLabelText('Manzil'), 'Chilonzor 7')
    await userEvent.click(screen.getByRole('button', { name: 'pick-point' }))
    expect(screen.getByLabelText('Kenglik (lat)')).toHaveValue('41.2755')
    expect(screen.getByLabelText('Uzunlik (lng)')).toHaveValue('69.2034')

    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Chilonzor P1',
      address: 'Chilonzor 7',
      lat: 41.2755,
      lng: 69.2034,
    })
  })

  it('rejects an opening time without a closing time', async () => {
    const onSubmit = vi.fn()
    render(
      <ParkingForm
        onSubmit={onSubmit}
        initialValues={{ name: 'A', address: 'B', lat: 41, lng: 69 }}
      />,
    )
    await userEvent.type(screen.getByLabelText('Ochilish vaqti'), '08:00')
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    expect(
      await screen.findByText('Ochilish va yopilish vaqti birga kiritilishi kerak'),
    ).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('requires an owner id when an admin creates a lot', async () => {
    const onSubmit = vi.fn()
    render(
      <ParkingForm
        requireOwner
        onSubmit={onSubmit}
        initialValues={{ name: 'A', address: 'B', lat: 41, lng: 69 }}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    expect(await screen.findByText('Majburiy maydon')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows a server error message', () => {
    const error = new ApiError(409, { detail: 'Lot is locked' }, 'http')
    render(<ParkingForm onSubmit={vi.fn()} error={error} />)
    expect(screen.getByText('Lot is locked')).toBeInTheDocument()
  })
})
