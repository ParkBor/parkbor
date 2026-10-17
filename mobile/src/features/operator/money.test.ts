import { describe, expect, it } from 'vitest';

import { isZeroMoney } from '@/features/operator/money';

describe('isZeroMoney', () => {
  it.each(['0', '0.00', '000.0', '0.0000'])('%s is zero', (v) => expect(isZeroMoney(v)).toBe(true));
  it.each(['1', '0.01', '', '.', '-0', 'x'])('%j is not zero', (v) => expect(isZeroMoney(v)).toBe(false));
});
