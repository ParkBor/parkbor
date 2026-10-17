import { describe, expect, it } from 'vitest';

import { createTokenLock } from '@/lib/tokenLock';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createTokenLock', () => {
  it('runs tasks strictly one after another, in call order', async () => {
    const lock = createTokenLock();
    const log: string[] = [];
    const gate = deferred();

    const a = lock.run(async () => {
      log.push('a:start');
      await gate.promise;
      log.push('a:end');
    });
    const b = lock.run(async () => {
      log.push('b:start');
    });
    const c = lock.run(async () => {
      log.push('c:start');
    });

    await Promise.resolve();
    expect(log).toEqual(['a:start']);
    gate.resolve();
    await Promise.all([a, b, c]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'c:start']);
  });

  it('returns each task result', async () => {
    const lock = createTokenLock();
    await expect(lock.run(async () => 42)).resolves.toBe(42);
  });

  it('keeps going after a task fails and surfaces the error only to its caller', async () => {
    const lock = createTokenLock();
    const failing = lock.run(async () => {
      throw new Error('boom');
    });
    const next = lock.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('survives a task that throws synchronously', async () => {
    const lock = createTokenLock();
    const failing = lock.run(() => {
      throw new Error('sync');
    });
    await expect(failing).rejects.toThrow('sync');
    await expect(lock.run(async () => 1)).resolves.toBe(1);
  });

  it('never overlaps tasks even when they finish out of order', async () => {
    const lock = createTokenLock();
    let active = 0;
    let maxActive = 0;
    const task = (ms: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, ms));
      active -= 1;
    };
    await Promise.all([lock.run(task(20)), lock.run(task(1)), lock.run(task(5))]);
    expect(maxActive).toBe(1);
  });
});
