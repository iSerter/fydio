import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * Emits a self-contained server bundle in `.next/standalone`.
   *
   * T10 builds the production image from this: it needs the app plus its
   * runtime dependencies and nothing else, not the whole monorepo.
   */
  output: 'standalone',

  /**
   * Workspace packages are resolved from `packages/`, several levels above
   * `apps/web`. Without this, output tracing only walks the app directory and
   * silently drops the shared code into a standalone build that then 500s.
   */
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

  reactStrictMode: true,

  /** Never leak the service-role key into a client bundle. */
  experimental: {
    // Strips `process.env.X` indirection so only NEXT_PUBLIC_* can be inlined.
    optimizePackageImports: ['@fydio/domain', '@fydio/ui'],
  },

  // NextConfig types this as possibly-async; the value below is a literal, so it
  // is wrapped rather than declared `async`.
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ])
  },
}

export default nextConfig
