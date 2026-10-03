-- Fydio baseline seed.
--
-- T01 has no business schema, so this is a smoke check rather than fixture
-- data: it proves the stack initialised, the roles RLS will depend on exist,
-- and the connection can actually run SQL. Real seed data lands in T02.
--
-- Deliberately tolerant about migration history — `supabase_migrations.schema_migrations`
-- only appears once T02 adds its first migration, so asserting on it here would
-- fail on a correct fresh checkout.
--
-- Run with: pnpm db:seed

\set ON_ERROR_STOP on

-- Roles the Supabase stack provisions; T02's RLS policies depend on all three.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r) INTO missing
  FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing Supabase role(s): % — the database was not initialised by the Supabase image', missing;
  END IF;

  RAISE NOTICE 'seed: anon, authenticated and service_role are present';
END
$$;

-- The public schema must exist and be writable by the app's roles, otherwise
-- T02's first migration will fail in a confusing way.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'public') THEN
    RAISE EXCEPTION 'the public schema does not exist';
  END IF;

  IF NOT has_schema_privilege('anon', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'anon cannot use the public schema';
  END IF;

  RAISE NOTICE 'seed: public schema exists and is usable by anon';
END
$$;

SELECT 1 AS fydio_seed_ok;
