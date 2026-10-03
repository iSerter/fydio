/**
 * `@fydio/ui` — shared primitives and the class-name helper.
 *
 * Server Components by default. Any component that needs interactivity must opt
 * in with `'use client'` at the top of its own file; doing it here would drag the
 * whole barrel across the client boundary.
 */
export { cn, clsx, type ClassValue } from './cn.js'
export {
  Badge,
  Button,
  Card,
  Stack,
  type BadgeProps,
  type BadgeTone,
  type ButtonProps,
  type CardProps,
  type StackProps,
} from './primitives.js'
