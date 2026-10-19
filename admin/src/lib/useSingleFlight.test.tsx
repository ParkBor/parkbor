import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSingleFlight } from './useSingleFlight'

function deferred() {
  let resolve: () => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useSingleFlight', () => {
  it('drops a second call made in the same tick', async () => {
    const { result } = renderHook(() => useSingleFlight())
    const gate = deferred()
    const task = vi.fn(() => gate.promise)
    const first = result.current(task)
    const second = result.current(task) // synchronous second click
    expect(task).toHaveBeenCalledTimes(1)
    gate.resolve()
    await first
    expect(await second).toBeUndefined()
  })

  it('allows the next call once the first has finished', async () => {
    const { result } = renderHook(() => useSingleFlight())
    const task = vi.fn(async () => 'ok')
    expect(await result.current(task)).toBe('ok')
    expect(await result.current(task)).toBe('ok')
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('releases the lock when the task fails, and passes the error on', async () => {
    const { result } = renderHook(() => useSingleFlight())
    await expect(
      result.current(async () => {
        throw new Error('boom')
      }),
    ).rejects.toMatchObject({ message: 'boom' })
    const task = vi.fn(async () => 1)
    expect(await result.current(task)).toBe(1)
  })

  it('also guards synchronous tasks and keeps one lock per hook instance', async () => {
    const a = renderHook(() => useSingleFlight())
    const b = renderHook(() => useSingleFlight())
    const gate = deferred()
    const first = a.result.current(() => gate.promise)
    expect(await b.result.current(async () => 'independent')).toBe('independent')
    gate.resolve()
    await first
  })
})
