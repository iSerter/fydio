import { describe, expect, it } from 'vitest'

import { toBand, type Band } from '../src/bands'

describe('Extension band classification (bands.ts)', () => {
  it('maps durations under 15 seconds to lt_15s', () => {
    expect(toBand(0)).toBe('lt_15s')
    expect(toBand(100)).toBe('lt_15s')
    expect(toBand(14_999)).toBe('lt_15s')
  })

  it('maps durations between 15 seconds and 1 minute to s15_60', () => {
    expect(toBand(15_000)).toBe('s15_60')
    expect(toBand(30_000)).toBe('s15_60')
    expect(toBand(59_999)).toBe('s15_60')
  })

  it('maps durations between 1 minute and 3 minutes to m1_3', () => {
    expect(toBand(60_000)).toBe('m1_3')
    expect(toBand(120_000)).toBe('m1_3')
    expect(toBand(179_999)).toBe('m1_3')
  })

  it('maps durations of 3 minutes or more to gt_3', () => {
    expect(toBand(180_000)).toBe('gt_3')
    expect(toBand(300_000)).toBe('gt_3')
    expect(toBand(3_600_000)).toBe('gt_3')
  })

  it('maps non-finite, negative, or invalid numbers to unknown', () => {
    expect(toBand(-1)).toBe('unknown')
    expect(toBand(-15_000)).toBe('unknown')
    expect(toBand(Number.NaN)).toBe('unknown')
    expect(toBand(Number.POSITIVE_INFINITY)).toBe('unknown')
    expect(toBand(Number.NEGATIVE_INFINITY)).toBe('unknown')
  })

  it('ensures output is strictly a Band type and does not retain the raw number', () => {
    const validBands: Band[] = ['lt_15s', 's15_60', 'm1_3', 'gt_3', 'unknown']
    const result = toBand(42_000)

    expect(validBands).toContain(result)
    expect(typeof result).toBe('string')
    expect(result).not.toBe(42_000)
  })
})
