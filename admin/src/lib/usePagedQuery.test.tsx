import { ApiError, type Paginated } from '@habi/api-client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { usePagedQuery } from './usePagedQuery'
import type { ServerTable } from './useServerTable'

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const table = (page: number, setPage = vi.fn()): ServerTable<object> => ({
  page,
  pageSize: 20,
  filters: {},
  setFilter: vi.fn(),
  setPage,
})
const result = (n: number): Paginated<number> => ({ count: n, next: null, previous: null, results: [n] })

describe('usePagedQuery', () => {
  it('passes page and page_size to the fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue(result(1))
    const { result: hook } = renderHook(() => usePagedQuery(['k'], table(3), fetcher), { wrapper })
    await waitFor(() => expect(hook.current.data).toBeDefined())
    expect(fetcher).toHaveBeenCalledWith({ page: 3, page_size: 20 })
  })

  it('steps back one page when the server says the page is out of range', async () => {
    const setPage = vi.fn()
    const fetcher = vi.fn().mockRejectedValue(new ApiError(404, { detail: 'Invalid page.' }, 'http'))
    renderHook(() => usePagedQuery(['k'], table(4, setPage), fetcher), { wrapper })
    await waitFor(() => expect(setPage).toHaveBeenCalledWith(3, 20))
  })

  it('does not step back from page 1 or for other errors', async () => {
    const setPage = vi.fn()
    const fetcher = vi.fn().mockRejectedValue(new ApiError(404, { detail: 'Invalid page.' }, 'http'))
    const { result: hook } = renderHook(() => usePagedQuery(['k'], table(1, setPage), fetcher), { wrapper })
    await waitFor(() => expect(hook.current.isError).toBe(true))
    expect(setPage).not.toHaveBeenCalled()
  })

  it('keeps the previous rows while the next page loads', async () => {
    let page = 1
    let release: (value: Paginated<number>) => void = () => undefined
    const fetcher = vi.fn((p: { page: number }) =>
      p.page === 1 ? Promise.resolve(result(1)) : new Promise<Paginated<number>>((resolve) => (release = resolve)),
    )
    const { result: hook, rerender } = renderHook(() => usePagedQuery(['k'], table(page), fetcher), { wrapper })
    await waitFor(() => expect(hook.current.data?.results).toEqual([1]))
    page = 2
    rerender()
    expect(hook.current.data?.results).toEqual([1])
    expect(hook.current.isPlaceholderData).toBe(true)
    release(result(2))
    await waitFor(() => expect(hook.current.data?.results).toEqual([2]))
  })
})
