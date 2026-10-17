import type { Paginated } from '@habi/api-client'
import { describe, expect, it, vi } from 'vitest'
import { fetchAll, MAX_PAGES, PaginationLimitError } from './fetchAll'

const page = (results: number[], next: string | null): Paginated<number> => ({
  count: results.length,
  next,
  previous: null,
  results,
})

describe('fetchAll', () => {
  it('collects every page until next is null', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], 'n'))
      .mockResolvedValueOnce(page([3], null))
    expect(await fetchAll<number>(list)).toEqual([1, 2, 3])
    expect(list).toHaveBeenNthCalledWith(2, { page: 2, page_size: 100 })
  })

  it('throws instead of silently truncating when the page limit is reached', async () => {
    const list = vi.fn(async () => page([1], 'more'))
    const error = await fetchAll<number>(list).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PaginationLimitError)
    expect(list).toHaveBeenCalledTimes(MAX_PAGES)
  })

  it('succeeds when the last allowed page has no next', async () => {
    let n = 0
    const list = vi.fn(async () => {
      n += 1
      return page([n], n === MAX_PAGES ? null : 'more')
    })
    expect(await fetchAll<number>(list)).toHaveLength(MAX_PAGES)
  })

  it('propagates list errors', async () => {
    const list = vi.fn(() => Promise.reject(new Error('boom')))
    await expect(fetchAll<number>(list)).rejects.toMatchObject({ message: 'boom' })
  })
})
