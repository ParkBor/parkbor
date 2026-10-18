import { useCallback, useState } from 'react'

export const DEFAULT_PAGE_SIZE = 20

export interface ServerTable<F> {
  page: number
  pageSize: number
  filters: F
  /** Change one filter; the table goes back to page 1 (the old page may not exist any more). */
  setFilter: <K extends keyof F>(key: K, value: F[K]) => void
  setPage: (page: number, pageSize: number) => void
}

/** Page, page size and filters of a server-paginated table. */
export function useServerTable<F extends object>(initial: F): ServerTable<F> {
  const [state, setState] = useState({ page: 1, pageSize: DEFAULT_PAGE_SIZE, filters: initial })
  const setFilter = useCallback(<K extends keyof F>(key: K, value: F[K]) => {
    setState((prev) => ({ ...prev, page: 1, filters: { ...prev.filters, [key]: value } }))
  }, [])
  const setPage = useCallback((page: number, pageSize: number) => {
    // A new page size restarts at page 1.
    setState((prev) => ({ ...prev, page: pageSize === prev.pageSize ? page : 1, pageSize }))
  }, [])
  return { page: state.page, pageSize: state.pageSize, filters: state.filters, setFilter, setPage }
}
