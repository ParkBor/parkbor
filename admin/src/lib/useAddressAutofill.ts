import { useCallback, useEffect, useRef } from 'react'
import { reverseGeocode } from './reverseGeocode'

export const AUTOFILL_DEBOUNCE_MS = 600

interface AutofillOptions {
  language: string
  getAddress: () => string
  setAddress: (value: string) => void
  delayMs?: number
}

/**
 * Fills the address field from a picked map point. One request per finished pick (debounced), the
 * previous request is cancelled, a failure does nothing. The field is only written while it is
 * empty or still holds the value this hook wrote last: text the user typed is never replaced.
 */
export function useAddressAutofill({ language, getAddress, setAddress, delayMs = AUTOFILL_DEBOUNCE_MS }: AutofillOptions) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const controller = useRef<AbortController | null>(null)
  const lastAuto = useRef<string | null>(null)
  const latest = useRef({ language, getAddress, setAddress })
  useEffect(() => {
    latest.current = { language, getAddress, setAddress }
  })

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    controller.current?.abort()
    timer.current = null
    controller.current = null
  }, [])
  useEffect(() => cancel, [cancel])

  return useCallback(
    (lat: number, lng: number) => {
      cancel()
      timer.current = setTimeout(() => {
        const own = new AbortController()
        controller.current = own
        void reverseGeocode(lat, lng, { language: latest.current.language, signal: own.signal }).then(
          (address) => {
            if (own.signal.aborted || !address) return
            const current = latest.current.getAddress()
            if (current.trim() !== '' && current !== lastAuto.current) return
            lastAuto.current = address
            latest.current.setAddress(address)
          },
        )
      }, delayMs)
    },
    [cancel, delayMs],
  )
}
