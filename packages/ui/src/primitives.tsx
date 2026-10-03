import type { ReactNode } from 'react'

import { cn } from './cn.js'

/**
 * Primitive components.
 *
 * Deliberately dependency-light: T01 has no design system to install, and
 * pulling one in now would fix the visual language before any of the actual
 * product surfaces exist to design for. These are the building blocks the feed
 * and inbox in T07–T09 will compose.
 *
 * Styling uses the semantic tokens from `@fydio/config-tailwind/preset.css`
 * (`bg-surface`, `text-ink`, `border-border`, `bg-brand`) rather than raw palette
 * colours, so the dark variants stay in lockstep.
 */

export interface CardProps {
  children: ReactNode
  className?: string
  /** A short heading above the card body. */
  title?: string
}

export function Card({ children, className, title }: CardProps) {
  return (
    <section
      className={cn(
        'rounded-card border border-border bg-surface p-5 text-ink shadow-sm',
        className,
      )}
    >
      {title ? <h2 className="mb-3 text-sm font-semibold text-ink-muted">{title}</h2> : null}
      {children}
    </section>
  )
}

export type BadgeTone = 'neutral' | 'brand' | 'positive' | 'warning' | 'critical'

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-ink-muted border-border',
  brand: 'bg-brand-soft text-brand border-brand/20',
  positive: 'bg-positive/10 text-positive border-positive/20',
  warning: 'bg-warning/15 text-warning border-warning/25',
  critical: 'bg-critical/10 text-critical border-critical/25',
}

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  className?: string
}

/**
 * A small status label.
 *
 * `tone` is a closed union rather than a free-form className string so a
 * component can never pass an unstyled or un-themed variant by accident.
 */
export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export interface ButtonProps {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost'
  type?: 'button' | 'submit'
  disabled?: boolean
  className?: string
  onClick?: () => void
}

const BUTTON_VARIANTS = {
  primary: 'bg-brand text-white hover:bg-brand-hover',
  secondary: 'border border-border bg-surface text-ink hover:bg-surface-muted',
  ghost: 'text-ink-muted hover:bg-surface-muted hover:text-ink',
} as const

export function Button({
  children,
  variant = 'primary',
  type = 'button',
  disabled = false,
  className,
  onClick,
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-control px-4 py-2',
        'text-sm font-medium transition-colors',
        'focus-visible:ring-brand focus-visible:ring-2 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {children}
    </button>
  )
}

export interface StackProps {
  children: ReactNode
  /** Tailwind gap step: 1 → `gap-1` … 8 → `gap-8`. */
  gap?: 1 | 2 | 3 | 4 | 5 | 6 | 8
  direction?: 'row' | 'column'
  className?: string
}

/** Vertical or horizontal flow with consistent spacing. */
export function Stack({ children, gap = 4, direction = 'column', className }: StackProps) {
  return (
    <div
      className={cn(
        'flex',
        direction === 'row' ? 'flex-row items-center' : 'flex-col',
        `gap-${gap}`,
        className,
      )}
    >
      {children}
    </div>
  )
}
