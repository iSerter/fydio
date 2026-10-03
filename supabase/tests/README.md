# pgTAP tests

Schema invariants live here. T02 adds the first suite, covering the guarantees
the product brief treats as non-negotiable:

- Profile hashtags: five is a hard maximum
- Content entries: exactly three hashtags
- One credit per submission, debited atomically
- Credits are spendable; Reputation is not
- Credit balances stay private

## Running

The Supabase CLI ships pgTAP as an extension, so a test file is plain SQL:

```sql
begin;
select plan(1);
select has_table('public', 'content_entries', 'content entries exist');
select * from finish();
rollback;
```

Run them against the local stack:

```bash
# via the CLI
supabase test db --db-url "$DATABASE_URL"

# or directly
docker compose -f docker/docker-compose.yml \
  -f docker/docker-compose.dev.yml --env-file docker/.env \
  exec -T db psql -U postgres -d postgres -f supabase/tests/<name>.sql
```

The `begin … rollback` wrapper is required: each test runs in a transaction that
is rolled back, so a test can never leave state behind for the next one.

## Why these are in SQL and not TypeScript

A constraint enforced only in application code is a convention. Enforced in the
database, it holds for every client — including the service-role code and any
future RPC — and a test that proves it cannot be satisfied by a code path that
forgot to check.
