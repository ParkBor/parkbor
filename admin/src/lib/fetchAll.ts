import type { Paginated } from '@habi/api-client'

export const MAX_PAGES = 20
const PAGE_SIZE = 100

/** More pages exist than fetchAll is willing to read; the partial list must not be used. */
export class PaginationLimitError extends Error {
  constructor() {
    super(`Collection has more than ${MAX_PAGES * PAGE_SIZE} items`)
    this.name = 'PaginationLimitError'
  }
}

/**
 * Read every page of a (small) paginated collection, e.g. the zones of one lot.
 * Throws PaginationLimitError rather than silently returning a truncated list.
 */
export async function fetchAll<T>(
  list: (params: { page: number; page_size: number }) => Promise<Paginated<T>>,
): Promise<T[]> {
  const items: T[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await list({ page, page_size: PAGE_SIZE })
    items.push(...result.results)
    if (!result.next) return items
  }
  throw new PaginationLimitError()
}
