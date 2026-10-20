import type { ParkingLotInput } from '@habi/api-client'
import type { ParkingFormValues } from '../schemas'

export function toPayload(values: ParkingFormValues): ParkingLotInput {
  return {
    name: values.name,
    address: values.address,
    location: { lat: values.lat, lng: values.lng },
    open_time: values.open_time === '' ? null : values.open_time,
    close_time: values.close_time === '' ? null : values.close_time,
    ...(values.owner_telegram_id ? { owner_telegram_id: Number(values.owner_telegram_id) } : {}),
  }
}
