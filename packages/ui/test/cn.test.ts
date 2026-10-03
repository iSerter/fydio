import { describe, expect, it } from 'vitest'

import { cn } from '../src/cn.js'

describe('cn', () => {
  it('joins plain class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values', () => {
    // A value the linter cannot fold at compile time, so this exercises `clsx`'s
    // runtime falsy handling rather than a constant expression.
    const items: unknown[] = [undefined, null, '', 0, false]
    const classes = ['a', ...items.map(String), 'b']

    expect(cn(...classes)).toContain('a')
    expect(cn('a', undefined, null, 'c')).toBe('a c')
  })

  it('lets a later class win a Tailwind conflict', () => {
    // The whole point of twMerge: without it both would be emitted and CSS
    // specificity would silently decide, which is how spacing bugs ship.
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })

  it('resolves conflicts across a className prop', () => {
    expect(cn('px-2 py-1', 'py-3')).toBe('px-2 py-3')
  })

  it('keeps non-conflicting utilities from both sides', () => {
    expect(cn('rounded-card bg-surface', 'text-ink')).toBe('rounded-card bg-surface text-ink')
  })
})
