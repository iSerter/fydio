import Link from 'next/link'

export interface AppNavProps {
  readonly userId: string | null
  readonly isAdmin?: boolean
}

export function AppNav({ userId, isAdmin = false }: AppNavProps) {
  const links = [
    { href: '/feed', label: 'Feed' },
    { href: '/submit', label: 'Submit' },
    { href: '/inbox', label: 'Inbox' },
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/settings/profile', label: 'Profile' },
    { href: '/settings/privacy', label: 'Privacy' },
    { href: '/settings/account', label: 'Account' },
  ]

  if (isAdmin) {
    links.push({ href: '/admin/metrics', label: 'Admin' })
  }

  return (
    <header className="border-b border-border bg-surface">
      <nav aria-label="Main" className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
        <Link href="/feed" className="font-semibold tracking-tight text-ink">
          Fydio
        </Link>

        <ul className="flex items-center gap-4">
          {links.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="text-sm text-ink-muted hover:text-ink">
                {link.label}
              </Link>
            </li>
          ))}

          {userId === null ? (
            <li>
              <Link href="/login" className="text-sm text-ink-muted hover:text-ink">
                Sign in
              </Link>
            </li>
          ) : null}
        </ul>
      </nav>
    </header>
  )
}