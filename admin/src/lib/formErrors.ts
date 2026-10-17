import { useEffect, useMemo } from 'react'
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { parseApiError } from './errors'

/**
 * Bind a backend error to form fields. `fieldMap` maps backend field names to form field names
 * (e.g. location -> lat). Messages with no matching field are returned as the general message.
 */
export function useServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fieldMap: Partial<Record<string, Path<T>>>,
): string | null {
  const parsed = useMemo(() => parseApiError(error), [error])

  useEffect(() => {
    for (const [field, messages] of Object.entries(parsed.fields)) {
      const target = Object.hasOwn(fieldMap, field) ? fieldMap[field] : undefined
      if (target) setError(target, { type: 'server', message: messages.join(' ') })
    }
    // fieldMap is a stable per-form constant
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, setError])

  const unmapped = Object.entries(parsed.fields)
    .filter(([field]) => !Object.hasOwn(fieldMap, field))
    .map(([field, messages]) => `${field}: ${messages.join(' ')}`)
  const parts = [...(parsed.general ? [parsed.general] : []), ...unmapped]
  return parts.length > 0 ? parts.join('; ') : null
}
