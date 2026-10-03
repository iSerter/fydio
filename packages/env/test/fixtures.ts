/** A complete, valid server environment. Tests override single keys from this. */
export const validEnv = {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://127.0.0.1:8000',
  SUPABASE_ANON_KEY: 'anon-key-that-is-definitely-long-enough',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-definitely-long-enough',
  SUPABASE_JWT_SECRET: 'a'.repeat(32),
} as const satisfies Record<string, string>
