import type { CreditBalance, CreditSummary } from './signals.js'
import type { ReputationSummary } from './reputation.js'

/**
 * Credit/Reputation type separation (T05 + T06).
 *
 * The two community signals must never meet: Credits buy submissions,
 * Reputation measures helpfulness and cannot be spent. The `kind`
 * discriminant (`'credits'` vs `'reputation'`) makes a cross-assignment a
 * COMPILE error, and the assertions below turn a future conflation into a
 * build break rather than a silent prop pass.
 *
 * This module is the canonical proof. `signals.test.ts` asserts the runtime
 * half; the `@ts-expect-error` lines here assert the compile-time half.
 */

export type { CreditBalance, ReputationSummary }

/** A credit balance is never a valid reputation summary. */
export function isCreditBalance(value: CreditBalance | ReputationSummary): value is CreditBalance {
  return value.kind === 'credits'
}

/** A reputation summary is never a valid credit balance. */
export function isReputationSummary(
  value: CreditBalance | ReputationSummary,
): value is ReputationSummary {
  return value.kind === 'reputation'
}

/**
 * Compile-time assertion that `A` is NOT assignable to `B`.
 *
 * `NotAssignable` resolves to `true` when the types are correctly separated and
 * `false` when they have been conflated. `AssertTrue` then accepts only `true`, so
 * `AssertTrue<NotAssignable<A, B>>` fails to compile the moment `A` becomes
 * assignable to `B`.
 *
 * The two-step matters. A bare `never`-returning helper would type-check fine as an
 * UNUSED exported alias whether or not the property held — an exported type that
 * resolves to `never` raises no error, so the check would silently pass forever. The
 * constraint is what turns the result into a build break.
 *
 * THE PREVIOUS FORM WAS BROKEN TWICE. It used `declare const _credit` plus
 * `const _creditIsNotReputation: ReputationSummary = _credit`:
 *
 *   1. RUNTIME. `declare const` is type-only and emits nothing, but the `const` on
 *      the next line is a real statement reading a variable that does not exist, so
 *      importing anything from the `@fydio/domain` barrel threw
 *      `ReferenceError: _credit is not defined`. A compile-time check had been given
 *      a runtime cost that every consumer paid.
 *   2. `@ts-expect-error` on an unused local also suppresses the "declared but never
 *      used" diagnostic, so a future edit that removed the intended error would not
 *      have been caught by it either.
 *
 * The `[A] extends [B]` tuple wrapping is deliberate: bare `A extends B` distributes
 * over unions, so `never extends X` would silently pass for a union member.
 */
type NotAssignable<A, B> = [A] extends [B] ? false : true
type AssertTrue<T extends true> = T

/** A credit balance is not a reputation summary. */
export type CreditIsNotReputation = AssertTrue<
  NotAssignable<CreditBalance, ReputationSummary>
>

/** A reputation summary is not a credit balance. */
export type ReputationIsNotCredit = AssertTrue<
  NotAssignable<ReputationSummary, CreditBalance>
>

/**
 * A credit summary carries no `kind` discriminant, so it is neither signal — which is
 * what makes it safe to pass where a discriminated union is expected.
 */
export type CreditSummaryIsNotReputation = AssertTrue<
  NotAssignable<CreditSummary, ReputationSummary>
>

