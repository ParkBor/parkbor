import { ApiError } from '@habi/api-client'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ParkingForm } from './ParkingForm'

// Leaflet needs a real layout engine; replace the map by a button that "clicks" a point.
vi.mock('./MapPicker', () => ({
  MapPicker: ({ onChange }: { onChange: (v: { lat: number; lng: number }) => void }) => (
    <>
      <button type="button" onClick={() => onChange({ lat: 41.2755, lng: 69.2034 })}>
        pick-point
      </button>
      <button type="button" onClick={() => onChange({ lat: 41.3, lng: 69.3 })}>
        pick-other
      </button>
    </>
  ),
}))

const geocode = vi.hoisted(() => ({ reverseGeocode: vi.fn() }))
vi.mock('../lib/reverseGeocode', () => geocode)

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

  it('shows the owner field as optional with a hint, and submits without an owner', async () => {
    const onSubmit = vi.fn()
    render(
      <ParkingForm
        showOwner
        onSubmit={onSubmit}
        initialValues={{ name: 'A', address: 'B', lat: 41, lng: 69 }}
      />,
    )
    expect(screen.getByText(/@userinfobot orqali bilib olinadi/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].owner_telegram_id ?? '').toBe('')
  })

  it('submits the owner as typed digits', async () => {
    const onSubmit = vi.fn()
    render(<ParkingForm showOwner onSubmit={onSubmit} initialValues={{ name: 'A', address: 'B', lat: 41, lng: 69 }} />)
    await userEvent.type(screen.getByLabelText('Egasi (Telegram ID)'), '123456789')
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].owner_telegram_id).toBe('123456789')
  })

  it.each([
    ['owner_role_not_allowed', /roli avtoturargoh egasi bo‘lishga mos emas/],
    ['owner_inactive', /hisobi o‘chirilgan/],
    ['owner_ambiguous', /bir nechta hisob topildi/],
  ])('explains the server refusal %s on the owner input, not as server text', async (code, text) => {
    const error = new ApiError(400, { detail: 'English server text', code }, 'http')
    render(<ParkingForm showOwner onSubmit={vi.fn()} error={error} />)
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByText('English server text')).toBeNull()
  })

  it('binds a field error on owner_telegram_id to the owner input', async () => {
    const error = new ApiError(400, { owner_telegram_id: ['Enter a valid id.'] }, 'http')
    render(<ParkingForm showOwner onSubmit={vi.fn()} error={error} />)
    expect(await screen.findByText('Enter a valid id.')).toBeInTheDocument()
  })

  it('still rejects a malformed owner id', async () => {
    const onSubmit = vi.fn()
    render(
      <ParkingForm showOwner onSubmit={onSubmit} initialValues={{ name: 'A', address: 'B', lat: 41, lng: 69 }} />,
    )
    await userEvent.type(screen.getByLabelText('Egasi (Telegram ID)'), 'abc')
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    expect(await screen.findByText('Telegram ID faqat raqamlardan iborat musbat son bo‘lsin')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  describe('address autofill from the map point', () => {
    beforeEach(() => geocode.reverseGeocode.mockReset())

    it('fills an empty address after a pick (language, coordinates passed)', async () => {
      geocode.reverseGeocode.mockResolvedValue('Navoiy 3, Yunusobod')
      render(<ParkingForm onSubmit={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'pick-point' }))
      await waitFor(() => expect(screen.getByLabelText('Manzil')).toHaveValue('Navoiy 3, Yunusobod'))
      expect(geocode.reverseGeocode).toHaveBeenCalledWith(41.2755, 69.2034, expect.objectContaining({ language: 'uz' }))
    })

    it('never overwrites what the user typed', async () => {
      geocode.reverseGeocode.mockResolvedValue('Auto address')
      render(<ParkingForm onSubmit={vi.fn()} />)
      await userEvent.type(screen.getByLabelText('Manzil'), 'My own address')
      await userEvent.click(screen.getByRole('button', { name: 'pick-point' }))
      await waitFor(() => expect(geocode.reverseGeocode).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.getByLabelText('Manzil')).toHaveValue('My own address')
    })

    it('replaces its own previous value on the next pick, but not after the user edited it', async () => {
      geocode.reverseGeocode.mockResolvedValueOnce('First auto').mockResolvedValueOnce('Second auto').mockResolvedValueOnce('Third auto')
      render(<ParkingForm onSubmit={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'pick-point' }))
      await waitFor(() => expect(screen.getByLabelText('Manzil')).toHaveValue('First auto'))
      await userEvent.click(screen.getByRole('button', { name: 'pick-other' }))
      await waitFor(() => expect(screen.getByLabelText('Manzil')).toHaveValue('Second auto'))
      await userEvent.type(screen.getByLabelText('Manzil'), ' (north gate)')
      await userEvent.click(screen.getByRole('button', { name: 'pick-point' }))
      await waitFor(() => expect(geocode.reverseGeocode).toHaveBeenCalledTimes(3))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.getByLabelText('Manzil')).toHaveValue('Second auto (north gate)')
    })

    it('leaves the field empty and silent when the lookup fails', async () => {
      geocode.reverseGeocode.mockResolvedValue(null)
      render(<ParkingForm onSubmit={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'pick-point' }))
      await waitFor(() => expect(geocode.reverseGeocode).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.getByLabelText('Manzil')).toHaveValue('')
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('asks only once for quick successive picks (debounce)', async () => {
      geocode.reverseGeocode.mockResolvedValue('Once')
      render(<ParkingForm onSubmit={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'pick-point' }))
      await userEvent.click(screen.getByRole('button', { name: 'pick-other' }))
      await waitFor(() => expect(screen.getByLabelText('Manzil')).toHaveValue('Once'))
      expect(geocode.reverseGeocode).toHaveBeenCalledTimes(1)
      expect(geocode.reverseGeocode).toHaveBeenCalledWith(41.3, 69.3, expect.anything())
    })
  })

  it('shows a server error message', () => {
    const error = new ApiError(409, { detail: 'Lot is locked' }, 'http')
    render(<ParkingForm onSubmit={vi.fn()} error={error} />)
    expect(screen.getByText('Lot is locked')).toBeInTheDocument()
  })
})
