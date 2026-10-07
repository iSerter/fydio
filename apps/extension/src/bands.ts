/**
 * Coarse duration band classifier for the companion extension (T10).
 *
 * PRIVACY GUARANTEE: Raw durations exist only inside `toBand` at the moment
 * of classification, and are discarded immediately. Only the coarse band
 * leaves this module and crosses the network.
 */

export type Band = 'lt_15s' | 's15_60' | 'm1_3' | 'gt_3' | 'unknown'

export const BAND_BOUNDS_MS = {
  lt_15s: 15_000,
  s15_60: 60_000,
  m1_3: 180_000,
} as const

/**
 * Maps a raw active duration in milliseconds to a coarse band.
 *
 * Boundary rules (matching `@fydio/domain` and SQL enum):
 * - `< 15s` -> `'lt_15s'`
 * - `15s – 59.999s` -> `'s15_60'`
 * - `60s – 179.999s` -> `'m1_3'`
 * - `>= 180s` -> `'gt_3'`
 * - Negative, NaN, or non-finite numbers -> `'unknown'`
 */
export function toBand(ms: number): Band {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'unknown'
  }

  if (ms < BAND_BOUNDS_MS.lt_15s) {
    return 'lt_15s'
  }

  if (ms < BAND_BOUNDS_MS.s15_60) {
    return 's15_60'
  }

  if (ms < BAND_BOUNDS_MS.m1_3) {
    return 'm1_3'
  }

  return 'gt_3'
}
