'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/admin/metrics', label: 'Metrics' },
  { href: '/admin/reports', label: 'Reports' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/content', label: 'Content' },
  { href: '/admin/tags', label: 'Tags' },
  { href: '/admin/credits', label: 'Credits' },
  { href: '/admin/invites', label: 'Invites' },
]

export function AdminSubNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Admin Sections" className="flex items-center gap-1 border-b border-border pb-2">
      {TABS.map((tab) => {
        const isActive = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-control px-3.5 py-1.5 text-xs font-medium transition ${
              isActive
                ? 'bg-surface-elevated text-ink font-semibold border border-border shadow-xs'
                : 'text-ink-muted hover:text-ink hover:bg-surface-muted'
            }`}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
