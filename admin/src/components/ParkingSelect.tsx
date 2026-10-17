import { Select } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../lib/api'
import { QueryError } from './QueryError'

interface ParkingSelectProps {
  value?: string
  onChange: (id: string | undefined) => void
}

const SEARCH_DEBOUNCE_MS = 300
const SELECT_PAGE_SIZE = 50

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/**
 * Picks one of the parking lots the caller may see (the backend scopes the list). Options are
 * searched on the server, so lists longer than one page are never silently truncated.
 */
export function ParkingSelect({ value, onChange }: ParkingSelectProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  // The chosen lot's name is kept so it stays visible when a later search hides it.
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null)
  const search = useDebounced(text, SEARCH_DEBOUNCE_MS)
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['parkings', 'select', search],
    queryFn: () =>
      adminApi.parkings.list({ page_size: SELECT_PAGE_SIZE, ordering: 'name', search }),
  })
  return (
    <>
      {error ? <QueryError error={error} onRetry={() => void refetch()} /> : null}
      <Select<{ value: string; label: string } | undefined>
        showSearch
        labelInValue
        filterOption={false}
        onSearch={setText}
        style={{ minWidth: 280 }}
        placeholder={t('common.selectParking')}
        loading={isLoading}
        value={value ? { value, label: selectedLabel ?? value } : undefined}
        onChange={(option) => {
          setSelectedLabel(option ? String(option.label) : null)
          onChange(option?.value)
        }}
        options={(data?.results ?? []).map((lot) => ({ value: lot.id, label: lot.name }))}
      />
    </>
  )
}
