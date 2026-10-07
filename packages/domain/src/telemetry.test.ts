import { describe, expect, it } from 'vitest'

import {
  classifyDurationMs,
  coerceDurationBand,
  DURATION_BANDS,
  DURATION_BAND_LABELS,
  DURATION_CONSENT_COPY,
  DURATION_CONSENT_DISCLAIMER,
  RETURN_TOKEN_TTL_MINUTES,
} from './telemetry.js'

/**
 * The classifier and the band vocabulary (T08).
 *
 * The property that matters is not "15 seconds lands in s15_60" — it is that
 * EVERY input produces a band and no input produces anything else. A raw
 * duration must never survive classification, so the tests below assert the
 * output type, not the specific band, for every hostile input.
 */
describe('classifyDurationMs', () => {
  it('maps each documented range to its band', () => {
    expect(classifyDurationMs(0)).toBe('lt_15s')
    expect(classifyDurationMs(14_999)).toBe('lt_15s')
    expect(classifyDurationMs(15_000)).toBe('s15_60')
    expect(classifyDurationMs(59_999)).toBe('s15_60')
    expect(classifyDurationMs(60_000)).toBe('m1_3')
    expect(classifyDurationMs(179_999)).toBe('m1_3')
    expect(classifyDurationMs(180_000)).toBe('gt_3')
    expect(classifyDurationMs(3_600_000)).toBe('gt_3')
  })

  it('treats the boundaries as lower-inclusive, so no value falls between bands', () => {
    // The failure this guards: a boundary test written as `<=` on one side and
    // `<` on the other leaves an unreachable value or, worse, a value that
    // satisfies neither branch and returns undefined.
    for (const ms of [0, 14_999, 15_000, 59_999, 60_000, 179_999, 180_000, 1e12]) {
      expect(DURATION_BANDS).toContain(classifyDurationMs(ms))
    }
  })

  it('clamps anything it cannot trust to unknown rather than inventing a band', () => {
    // A negative reading means a broken clock, `NaN`/`Infinity` mean a divide
    // by zero somewhere upstream. Reporting "under 15 seconds" for any of them
    // would be a confident lie about somebody's behaviour.
    for (const ms of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(classifyDurationMs(ms)).toBe('unknown')
    }
  })
})

describe('coerceDurationBand', () => {
  it('passes every real band through unchanged', () => {
    for (const band of DURATION_BANDS) {
      expect(coerceDurationBand(band)).toBe(band)
    }
  })

  it('maps anything else to unknown, including numbers that look like durations', () => {
    // The critical case is the last-but-one: a raw millisecond count arriving
    // where a band was expected must NOT be stored as itself, and must not be
    // silently coerced into a band either.
    for (const raw of [1500, 'lt_15s ', 'LT_15S', null, undefined, {}, [], true]) {
      expect(coerceDurationBand(raw)).toBe('unknown')
    }
  })
})

describe('band vocabulary', () => {
  it('has a label for every band, because the privacy panel renders them', () => {
    for (const band of DURATION_BANDS) {
      expect(DURATION_BAND_LABELS[band]).toBeTruthy()
    }
  })

  it('keeps the consent copy narrow and names every guarantee the brief requires', () => {
    // Each phrase is a promise the product makes. Asserting them here means
    // editing the copy to sound better cannot quietly drop one.
    expect(DURATION_CONSENT_COPY).toMatch(/rough range/i)
    expect(DURATION_CONSENT_COPY).toMatch(/private to you/i)
    expect(DURATION_CONSENT_COPY).toMatch(/never\s+affects Credits or Reputation/i)
    expect(DURATION_CONSENT_COPY).toMatch(/delete past records at any time/i)
  })

  it('states the same guarantees in the short disclaimer', () => {
    expect(DURATION_CONSENT_DISCLAIMER).toMatch(/Private to you/)
    expect(DURATION_CONSENT_DISCLAIMER).toMatch(/Credits or Reputation/)
    expect(DURATION_CONSENT_DISCLAIMER).toMatch(/any time/)
  })

  it('expires return tokens inside the window the SQL enforces', () => {
    expect(RETURN_TOKEN_TTL_MINUTES).toBe(30)
  })
})
