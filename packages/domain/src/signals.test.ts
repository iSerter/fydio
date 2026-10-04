import { describe, expect, it } from 'vitest'

import {
  allCreditCopy,
  canAffordSubmission,
  CREDIT_COPY,
  formatCredits,
  formatHeldCredits,
  isAllowedCreditCopy,
  parseCreditSummary,
  toCreditBalance,
  type CreditBalance,
  type CreditSummary,
  type ReputationTotal,
} from './signals.js'

/**
 * Credit summary + copy guard (T05).
 *
 * The summary parser is the trust boundary between the `get_credit_summary`
 * RPC and every component that renders a balance; the copy guard keeps
 * "Credits" (spendable, private) distinct from "Reputation" (quality signal,
 * public). The forbidden terms live next to the copy they police so a new
 * string cannot dodge the scan by living in another module.
 */
describe('credit summary', () => {
  const payload = {
    available: 2,
    held: 1,
    total: 3,
    submissionCost: 1,
    history: [
      {
        created_at: '2026-01-01T00:00:00Z',
        delta: 3,
        kind: 'weekly_allowance',
        status: 'available',
        note: 'Weekly starter allowance',
        entry_url: null,
        feedback_id: null,
      },
    ],
  }

  it('parses the RPC payload into the summary shape', () => {
    const summary = parseCreditSummary(payload)
    expect(summary.available).toBe(2)
    expect(summary.held).toBe(1)
    expect(summary.history).toHaveLength(1)
    expect(summary.history[0]?.kind).toBe('weekly_allowance')
  })

  it('refuses malformed payloads rather than rendering them', () => {
    expect(() => parseCreditSummary(null)).toThrow()
    expect(() => parseCreditSummary({ ...payload, available: '2' })).toThrow()
    expect(() => parseCreditSummary({ ...payload, history: [{ delta: 1 }] })).toThrow()
  })

  it('bridges to the nominal balance so held credits never leak into spending', () => {
    const summary = parseCreditSummary(payload)
    const balance = toCreditBalance(summary)
    expect(balance).toEqual({ kind: 'credits', amount: 2 })
    // The summary carries held separately; affordability reads available only.
    expect(canAffordSubmission(balance, summary.submissionCost)).toBe(true)
    expect(canAffordSubmission(toCreditBalance({ available: 0 }), 1)).toBe(false)
  })

  it('pluralises Credits exactly, never "1 Credits" or "Creditss"', () => {
    expect(formatCredits(0)).toBe('0 Credits')
    expect(formatCredits(1)).toBe('1 Credit')
    expect(formatCredits(3)).toBe('3 Credits')
  })

  it('pluralises held credits exactly too', () => {
    expect(formatHeldCredits(1, 48).startsWith('1 Credit ')).toBe(true)
    expect(formatHeldCredits(2, 48).startsWith('2 Credits ')).toBe(true)
  })

  it('writes the guard message without forbidden terms', () => {
    expect(CREDIT_COPY.guardMessage(1)).toContain(formatCredits(1))
    expect(isAllowedCreditCopy(CREDIT_COPY.guardMessage(1))).toBe(true)
  })
})

describe('credit copy guard', () => {
  it('never calls Credits "points" or "pts"', () => {
    for (const text of allCreditCopy()) {
      expect(isAllowedCreditCopy(text), `forbidden term in: ${text}`).toBe(true)
    }
  })

  it('catches the conflation it exists to prevent', () => {
    expect(isAllowedCreditCopy('your points balance is 3')).toBe(false)
    expect(isAllowedCreditCopy('spend 1 point to publish')).toBe(false)
    expect(isAllowedCreditCopy('balance: 10 pts')).toBe(false)
  })

  it('allows score, a legitimate term owned by ranking (T07) and ratings (T06)', () => {
    expect(isAllowedCreditCopy('your ranking score rose')).toBe(true)
    expect(isAllowedCreditCopy('rated 8 out of 10')).toBe(true)
  })
})

/**
 * Credits and Reputation are structurally incompatible by construction.
 *
 * The `kind` discriminant makes a cross-assignment a COMPILE error, and the
 * `@ts-expect-error` lines below turn a future conflation into a build break
 * rather than a silent prop pass. The summary shape is asserted too: it must
 * never satisfy the reputation card, so a summary cannot reach a reputation
 * component even unlabelled.
 */
describe('credit/reputation type separation', () => {
  it('cannot cross-pass credit and reputation values', () => {
    const credit: CreditBalance = { kind: 'credits', amount: 3 }
    const reputation: ReputationTotal = { kind: 'reputation', amount: 42, ratedFeedbackCount: 5 }
    const summary: CreditSummary = {
      available: 3,
      held: 0,
      total: 3,
      submissionCost: 1,
      history: [],
    }

    // @ts-expect-error — a credit balance is not a reputation total
    const asReputation: ReputationTotal = credit
    // @ts-expect-error — a reputation total is not a credit balance
    const asCredit: CreditBalance = reputation
    // @ts-expect-error — a credit summary is not a reputation total either
    const summaryAsReputation: ReputationTotal = summary

    expect(asReputation).toBeDefined()
    expect(asCredit).toBeDefined()
    expect(summaryAsReputation).toBeDefined()
  })
})
