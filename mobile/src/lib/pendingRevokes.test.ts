import { describe, expect, it, vi } from 'vitest';

import {
  addPending,
  MAX_PENDING_REVOKES,
  parsePending,
  removePending,
  serializePending,
  type PendingRevoke,
} from '@/lib/pendingRevokes';

const e = (token: string, userId: PendingRevoke['userId'] = 1): PendingRevoke => ({ token, userId });

describe('parsePending', () => {
  it('returns [] for empty, corrupt or foreign data', () => {
    expect(parsePending(null)).toEqual([]);
    expect(parsePending('')).toEqual([]);
    expect(parsePending('not json')).toEqual([]);
    expect(parsePending('{"a":1}')).toEqual([]);
    expect(parsePending('"str"')).toEqual([]);
  });

  it('keeps only well-formed entries', () => {
    const raw = JSON.stringify([e('a', 1), { token: 5 }, null, { token: 'b', userId: null }, { token: '' }, e('c', 'u-3')]);
    expect(parsePending(raw)).toEqual([e('a', 1), e('b', null), e('c', 'u-3')]);
  });

  it('round-trips through serializePending', () => {
    const list = [e('a'), e('b', null)];
    expect(parsePending(serializePending(list))).toEqual(list);
  });
});

describe('addPending', () => {
  it('appends new tokens', () => {
    expect(addPending([e('a')], e('b'))).toEqual([e('a'), e('b')]);
  });

  it('does not duplicate a token, refreshing its user binding instead', () => {
    expect(addPending([e('a', null)], e('a', 7))).toEqual([e('a', 7)]);
  });

  it('is bounded: the oldest entries drop out, a second entry never overwrites the first', () => {
    let list: PendingRevoke[] = [];
    for (let i = 0; i < MAX_PENDING_REVOKES + 2; i += 1) list = addPending(list, e(`t${i}`));
    expect(list).toHaveLength(MAX_PENDING_REVOKES);
    expect(list[0]?.token).toBe('t2');
    expect(list.at(-1)?.token).toBe(`t${MAX_PENDING_REVOKES + 1}`);
    expect(addPending([e('first')], e('second')).map((x) => x.token)).toEqual(['first', 'second']);
  });

  it('reports how many old entries it dropped', () => {
    const onDrop = vi.fn();
    let list: PendingRevoke[] = [];
    for (let i = 0; i < MAX_PENDING_REVOKES; i += 1) list = addPending(list, e(`t${i}`), onDrop);
    expect(onDrop).not.toHaveBeenCalled();
    addPending(list, e('overflow'), onDrop);
    expect(onDrop).toHaveBeenCalledWith(1);
  });

  it('does not mutate its input', () => {
    const list = [e('a')];
    addPending(list, e('b'));
    expect(list).toEqual([e('a')]);
  });
});

describe('removePending', () => {
  it('removes by token only', () => {
    expect(removePending([e('a'), e('b')], 'a')).toEqual([e('b')]);
    expect(removePending([e('a')], 'zzz')).toEqual([e('a')]);
  });
});
