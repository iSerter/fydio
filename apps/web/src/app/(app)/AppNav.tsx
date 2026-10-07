import Link from 'next/link'

/**
 * The member navigation bar (T03).
 *
 * A Server Component. The links are static, and the only dynamic part is whether a member is
 * signed in -- which the layout already knows and passes in. Making this a Client Component
 * would ship a navigation bar to the browser on every page for no interactive behaviour.
 *
 * The member's own profile link is rendered only when signed in, because building a `/u/...`
 * href requires a handle we have not read here -- and reading it would mean a profile query on
 * every page render for one link.
 */
export interface AppNavProps {
  readonly userId: string | null
}

export function AppNav({ userId }: AppNavProps) {
  const links = [
    { href: '/feed', label: 'Feed' },
    { href: '/submit', label: 'Submit' },
    { href: '/settings/profile', label: 'Profile' },
    { href: '/settings/privacy', label: 'Privacy' },
    { href: '/settings/account', label: 'Account' },
  ]

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

          {/* No sign-out link here. It lives on `/settings/account`, which explains the
              session model before offering to end it -- signing out is a decision, not a
              button you want next to "Profile". */}
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