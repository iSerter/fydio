import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge Tailwind class names, with later classes winning conflicts.
 *
 * Both halves are needed: `clsx` handles conditional composition, and
 * `tailwind-merge` resolves the conflicts that `clsx` cannot — without it,
 * `<Button className="p-2">` inside a `p-4` container would emit both and let
 * CSS specificity silently decide, which is how spacing bugs survive review.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Compose class names without Tailwind-conflict resolution. */
export { clsx, type ClassValue } from 'clsx'
