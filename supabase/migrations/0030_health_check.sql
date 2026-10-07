-- =============================================================================
-- Migration 0030: Health check & migration head RPC
--
-- Exposes a function in `public` schema allowing the application and health
-- endpoints to verify database connectivity and read the current migration
-- head from `supabase_migrations.schema_migrations`.
-- =============================================================================

create or replace function public.get_migration_head()
returns text
language sql
stable
security definer
set search_path = public, supabase_migrations
as $$
  select version
    from supabase_migrations.schema_migrations
   order by version desc
   limit 1;
$$;

comment on function public.get_migration_head() is
  'Returns the latest applied migration version for health check verification.';

-- Callable by any role so the health check endpoint can verify database health.
grant execute on function public.get_migration_head() to anon, authenticated, service_role;
