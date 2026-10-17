import { ApiError } from '@habi/api-client'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { parkingSchema } from '../schemas'
import { BulkSlotsForm } from './BulkSlotsForm'
import { ParkingForm } from './ParkingForm'
import { TariffForm } from './TariffForm'
import { ZoneForm } from './ZoneForm'

vi.mock('./MapPicker', () => ({ MapPicker: () => null }))

const http = (body: unknown, status = 400) => new ApiError(status, body, 'http')
const zone = (name: string) => ({ id: 'z', parking_lot: 'l', name, floor: 0, created_at: '' })

describe('server errors are bound to form fields', () => {
  it('ZoneForm shows the backend message under the name field', async () => {
    render(
      <ZoneForm onSubmit={vi.fn()} error={http({ name: ['A zone with this name exists.'] })} />,
    )
    expect(await screen.findByText('A zone with this name exists.')).toBeInTheDocument()
  })

  it('TariffForm maps price_per_hour and shows a general message', async () => {
    render(
      <TariffForm
        onSubmit={vi.fn()}
        error={http({ price_per_hour: ['Bad price'], detail: 'Lot is locked' })}
      />,
    )
    expect(await screen.findByText('Bad price')).toBeInTheDocument()
    expect(screen.getByText('Lot is locked')).toBeInTheDocument()
  })

  it('ParkingForm maps location errors to the coordinate fields', async () => {
    render(<ParkingForm onSubmit={vi.fn()} error={http({ location: ['Outside Uzbekistan'] })} />)
    expect(await screen.findByText('Outside Uzbekistan')).toBeInTheDocument()
  })

  it('BulkSlotsForm shows a conflict as a general alert', async () => {
    render(
      <BulkSlotsForm
        zones={[zone('A')]}
        onSubmit={vi.fn()}
        error={http({ detail: 'Codes already exist', code: 'conflict' }, 409)}
      />,
    )
    expect(await screen.findByText('Codes already exist')).toBeInTheDocument()
  })
})

describe('submit behaviour', () => {
  it('resets the form after a successful submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ZoneForm onSubmit={onSubmit} />)
    const name = screen.getByLabelText('Zona nomi')
    await userEvent.type(name, 'North')
    await userEvent.click(screen.getByRole('button', { name: /Zona qo.shish/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(name).toHaveValue(''))
  })

  it('keeps the values when the submit fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('boom'))
    render(<ZoneForm onSubmit={onSubmit} />)
    const name = screen.getByLabelText('Zona nomi')
    await userEvent.type(name, 'North')
    await userEvent.click(screen.getByRole('button', { name: /Zona qo.shish/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(name).toHaveValue('North')
  })

  it('ignores a second click while the first submit is still running', async () => {
    let finish: () => void = () => undefined
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(<ZoneForm onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText('Zona nomi'), 'North')
    const button = screen.getByRole('button', { name: /Zona qo.shish/ })
    await userEvent.click(button)
    await userEvent.click(button)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    finish()
  })
})

describe('form accessibility and defaults', () => {
  it('labels the forms through i18n, not hard-coded English ids', () => {
    render(<ZoneForm onSubmit={vi.fn()} />)
    expect(screen.getByRole('form', { name: 'Zona shakli' })).toBeInTheDocument()
  })

  it('associates Select and InputNumber with their labels', () => {
    render(<BulkSlotsForm zones={[zone('A')]} onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('Zona')).toBeInTheDocument()
    expect(screen.getByLabelText('Boshlanish')).toBeInTheDocument()
    expect(screen.getByLabelText('Turi')).toBeInTheDocument()
  })

  it('does not preset a prefix that the backend would reject', () => {
    render(<BulkSlotsForm zones={[zone('North wing')]} onSubmit={vi.fn()} />)
    expect(screen.getByLabelText(/Prefiks/)).toHaveValue('')
  })
})

describe('owner id validation', () => {
  const base = { name: 'A', address: 'B', lat: 41, lng: 69, open_time: '', close_time: '' }

  it('accepts a UUID or nothing', () => {
    const owner = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    expect(parkingSchema.safeParse({ ...base, owner }).success).toBe(true)
    expect(parkingSchema.safeParse({ ...base, owner: '' }).success).toBe(true)
    expect(parkingSchema.safeParse(base).success).toBe(true)
  })

  it('rejects a non-UUID owner', () => {
    const result = parkingSchema.safeParse({ ...base, owner: '123' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe('validation.uuid')
  })
})
