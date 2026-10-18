import type { Paginated } from '@habi/api-client'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { isPageOutOfRange } from './errors'
import type { ServerTable } from './useServerTable'

interface Paging {
  page: number
  page_size: number
}

/**
 * One server page of a table. The previous page stays on screen while the next one loads (no
 * flash, the pager does not jump), and a "page out of range" 404 (the last row of the last page
 * was removed) steps back one page instead of showing an error.
 */
export function usePagedQuery<T, F extends object>(
  key: readonly unknown[],
  table: ServerTable<F>,
  fetcher: (paging: Paging) => Promise<Paginated<T>>,
) {
  const { page, pageSize, setPage } = table
  const query = useQuery({
    queryKey: [...key, page, pageSize],
    queryFn: () => fetcher({ page, page_size: pageSize }),
    placeholderData: keepPreviousData,
  })
  const outOfRange = query.isError && isPageOutOfRange(query.error)
  useEffect(() => {
    if (outOfRange && page > 1) setPage(page - 1, pageSize)
  }, [outOfRange, page, pageSize, setPage])
  return query
}
