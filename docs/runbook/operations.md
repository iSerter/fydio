# Fydio — Operations & Maintenance Runbook

This runbook documents operational procedures for maintaining Fydio in production, including backups, restore drills, secret rotation, and stack upgrades.

---

## 1. Backups

### Database Backups (`pg_dump`)

Fydio includes an automated backup script at `scripts/backup.sh`.

```bash
# Generate a timestamped backup dump
bash scripts/backup.sh

# Or save to a specific directory/file
bash scripts/backup.sh /var/backups/fydio/fydio-$(date +%Y%m%d_%H%M%S).sql
```

The script:

1. Dumps `public`, `supabase_migrations`, `auth`, and `storage` schemas.
2. Strips table ownership and privileges to ensure portability across hosts.
3. Verifies that the resulting dump is non-empty.

### Persistent Volume Snapshots

To back up uploaded media assets (avatars, post covers, feedback images):

1. **Storage Volume**: Snapshot Docker volume `fydio_storage_data` (located at `/var/lib/docker/volumes/fydio_storage_data/_data`).
2. **Postgres Volume**: Snapshot Docker volume `fydio_db_data`.

### Automated Coolify Backup Schedule

In Coolify, create a scheduled Cron job on the host or inside a maintenance container:

```bash
0 2 * * * bash /repo/scripts/backup.sh /var/backups/fydio/fydio-daily-$(date +\%Y\%m\%d).sql
```

---

## 2. Restore Drills

To restore Fydio from a database backup dump:

```bash
# Ensure dump file is accessible
bash scripts/restore.sh /var/backups/fydio/fydio-backup.sql
```

### Restore Drill Procedure (Staging/Recovery Rehearsal)

1. Bring up a test or staging stack:
   ```bash
   docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d --wait
   ```
2. Execute the restore script:
   ```bash
   bash scripts/restore.sh /tmp/fydio-backup.sql
   ```
3. Run smoke verification:
   ```bash
   bash scripts/smoke-prod.sh
   ```
4. Verify table and row counts match the source database:
   ```sql
   select count(*) from profiles;
   select count(*) from content_entries;
   select count(*) from credit_ledger;
   select count(*) from duration_events;
   ```

---

## 3. Secret Rotation

### Rotating `JWT_SECRET` (and API Keys)

Rotating `JWT_SECRET` invalidates all existing user sessions and requires regenerating `ANON_KEY` and `SERVICE_ROLE_KEY`:

1. Generate a new 48-byte base64 secret:
   ```bash
   NEW_JWT_SECRET=$(openssl rand -base64 48)
   ```
2. Generate new `ANON_KEY` and `SERVICE_ROLE_KEY` signed with `NEW_JWT_SECRET`.
3. Update environment variables in Coolify for both **Resource 1 (Supabase Compose)** and **Resource 2 (Web Application)**.
4. Redeploy Supabase Compose, then redeploy Web Application.

### Rotating `CRON_SECRET`

`CRON_SECRET` protects internal recurring endpoints (`/api/cron/weekly-allowance`, `/api/cron/release-held`):

1. Generate a new secret:
   ```bash
   NEW_CRON_SECRET=$(openssl rand -hex 24)
   ```
2. Update `CRON_SECRET` in Coolify Web Application environment variables.
3. Update the `Authorization: Bearer <NEW_CRON_SECRET>` headers in Coolify's scheduled Cron jobs.
4. Redeploy Web Application.

### Rotating `EXTENSION_TOKEN_SECRET`

`EXTENSION_TOKEN_SECRET` signs short-lived duration telemetry tokens for the Chrome companion:

1. Generate a new secret (minimum 32 characters):
   ```bash
   NEW_EXT_SECRET=$(openssl rand -base64 32)
   ```
2. Update `EXTENSION_TOKEN_SECRET` in Coolify Web Application environment.
3. Redeploy Web Application.
4. Existing tokens will expire naturally within 15 minutes; the companion extension will automatically refresh tokens via its authenticated session.

---

## 4. Self-Hosted Supabase Upgrades

Fydio vendors trimmed upstream Supabase images and volume configurations. Upgrading follows a strict protocol:

1. Check current versions vs upstream:
   ```bash
   bash scripts/check-supabase-version.sh --check
   ```
2. Perform a full database backup:
   ```bash
   bash scripts/backup.sh /tmp/fydio-pre-upgrade-backup.sql
   ```
3. Update pinned image tags in `docker/docker-compose.yml`.
4. Re-vendor required volume configs if upstream changed configuration templates:
   ```bash
   # Re-vendor templates per docker/README.md instructions
   ```
5. Test locally:
   ```bash
   pnpm dev:stack:down
   pnpm dev:stack
   pnpm dev:stack:health
   pnpm test
   ```
6. Commit changes and deploy in Coolify:
   - Deploy Supabase Compose.
   - Run `pnpm db:migrate`.
   - Deploy Web Application.
   - Run `bash scripts/smoke-prod.sh`.

---

## 5. Health Monitoring & Alerts

| Check                   | Endpoint                              | Expected                               | Action if Failing                                     |
| :---------------------- | :------------------------------------ | :------------------------------------- | :---------------------------------------------------- |
| Gateway Health          | `https://api.<domain>/auth/v1/health` | `HTTP 200`                             | Check `fydio-api-gw` and `fydio-auth` container logs. |
| Application Health      | `https://app.<domain>/api/health`     | `HTTP 200` `{ database: "connected" }` | Check database connectivity and pooler status.        |
| Login Page              | `https://app.<domain>/login`          | `HTTP 200`                             | Check `fydio-web` container status.                   |
| Database Migration Head | Returned by `/api/health`             | Latest migration tag                   | Run `supabase db push` if database is behind.         |
