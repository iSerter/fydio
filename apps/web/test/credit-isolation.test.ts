import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Credit isolation guards (T05 §5.8).
 *
 * The brief forbids credits for views, likes, follows, shares, comments,
 * votes, and viewing time — and forbids any reputation→credit conversion.
 * These are STRUCTURAL guarantees, so they are asserted structurally: by
 * scanning the migrations rather than by running scenarios that could miss a
 * path.
 *
 * Each check names the function a violation would live in, because "a grep
 * failed" without a location is a chore to fix.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
// test/ → web/ → apps/ → repo root: three levels up.
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'supabase', 'migrations')

function readMigrations(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')) }))
}

/**
 * Remove `--` line comments so prose about a rule cannot match as the rule.
 * Naive by design: migration bodies quote strings far more than they comment
 * inside them, and a `--` inside a string literal would have to sit on the
 * same line as a credit keyword to matter — grep-grade precision, documented.
 */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const marker = line.indexOf('--')
      return marker === -1 ? line : line.slice(0, marker)
    })
    .join('\n')
}

/** Split a migration file into top-level function spans by name. */
function functionSpans(sql: string): { name: string; body: string }[] {
  // An exec loop rather than matchAll + indexing: every extracted piece is
  // guarded by a genuine null/undefined check, which keeps both tsc
  // (noUncheckedIndexedAccess) and the unnecessary-condition rule satisfied
  // without assertions.
  const pattern = /create or replace function public\.(\w+)\(/g
  const found: { name: string; start: number }[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql)) !== null) {
    // match.index is non-optional on RegExpExecArray; only the capture group
    // needs the guard.
    const name = match[1]
    if (name !== undefined) {
      found.push({ name, start: match.index })
    }
  }
  return found.map((fn, index) => {
    // Annotated, not inferred: tsc (noUncheckedIndexedAccess) and the lint
    // type-checker must agree this can be absent, and only the explicit union
    // makes both see it.
    const next: { name: string; start: number } | undefined = found[index + 1]
    const end = next === undefined ? sql.length : next.start
    return { name: fn.name, body: sql.slice(fn.start, end) }
  })
}

const migrations = readMigrations()
const functions = migrations.flatMap(({ file, sql }) =>
  functionSpans(sql).map((fn) => ({ ...fn, file })),
)

describe('credit isolation', () => {
  it('inserts feedback_earned credits only inside evaluate_feedback_eligibility', () => {
    // Statement-scoped: a function that SELECTS feedback_earned rows (capping,
    // reversing) is fine — only an INSERT that MINTS one is restricted.
    const offenders = functions.filter((fn) =>
      [...fn.body.matchAll(/insert into public\.credit_ledger[^;]*;/gi)].some((statement) =>
        statement[0].includes("'feedback_earned'"),
      ),
    ).filter((fn) => fn.name !== 'evaluate_feedback_eligibility')

    expect(
      offenders.map((fn) => `${fn.file}:${fn.name}`),
      'feedback_earned must be minted in exactly one function',
    ).toEqual([])
  })

  it('never reads the reputation ledger on any credit-awarding path', () => {
    const offenders = functions.filter(
      (fn) =>
        /insert into public\.credit_ledger/i.test(fn.body) &&
        (/reputation_ledger/i.test(fn.body) || /feedback_ratings/i.test(fn.body)),
    )

    expect(
      offenders.map((fn) => `${fn.file}:${fn.name}`),
      'no rating may influence a credit amount, even by accident',
    ).toEqual([])
  })

  it('never mints a credit from a platform engagement event', () => {
    // The open-history prerequisite in submit_feedback reads feed_impressions
    // but inserts NO credit row — that distinction is exactly what this check
    // encodes: engagement may gate, it may never pay.
    const engagement = /duration_events|outbound_clicks|feed_impressions|duration_band/i
    const offenders = functions.filter(
      (fn) => /insert into public\.credit_ledger/i.test(fn.body) && engagement.test(fn.body),
    )

    expect(
      offenders.map((fn) => `${fn.file}:${fn.name}`),
      'views, clicks, and viewing time must never appear in a credit insert',
    ).toEqual([])
  })

  it('mentions no like/follow/share/vote credit anywhere in the schema', () => {
    const offenders: string[] = []
    for (const { file, sql } of migrations) {
      for (const match of sql.matchAll(
        /credit[^\n]*\b(likes?|follows?|shares?|votes?|views?)\b|\b(likes?|follows?|shares?|votes?)\b[^\n]*credit/gi,
      )) {
        offenders.push(`${file}: ${match[0].trim().slice(0, 100)}`)
      }
    }

    expect(offenders, 'no engagement-based credit may exist in the schema').toEqual([])
  })
})
