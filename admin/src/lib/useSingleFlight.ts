import { useCallback, useRef } from 'react'

/**
 * Runs an action at most once at a time. The flag is a ref set SYNCHRONOUSLY, so a second click
 * in the same tick (double-click, Enter + click) is dropped before React has re-rendered a
 * disabled / loading button. A call made while another is running resolves to `undefined`.
 */
export function useSingleFlight() {
  const flying = useRef(false)
  return useCallback(async <T,>(task: () => Promise<T> | T): Promise<T | undefined> => {
    if (flying.current) return undefined
    flying.current = true
    try {
      return await task()
    } finally {
      flying.current = false
    }
  }, [])
}
