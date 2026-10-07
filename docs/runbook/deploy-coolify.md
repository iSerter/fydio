# Deploying Fydio to Coolify v4.11

This runbook guides operators through deploying Fydio to a production server using **Coolify v4.11**.

---

## Architecture Overview

Fydio deploys as **two independent resources** from this single Git repository:

```
[ Git Repository: iSerter/fydio ]
         │
         ├── Resource 1: Docker Compose (Supabase Stack)
         │   ├── Base directory: docker/
         │   ├── Files: docker-compose.yml + docker-compose.prod.yml
         │   ├── Exposed domain: api.<your-domain> (Envoy/Kong :8000)
         │   └── Persistent volumes: fydio_db_data, fydio_storage_data
         │
         └── Resource 2: Application (Next.js 16 Web)
             ├── Buildpack: Dockerfile
             ├── Dockerfile: apps/web/Dockerfile (Context: root)
             ├── Exposed domain: app.<your-domain> (:3000)
             └── Health check: /api/health
```

---

## Server Requirements

- **CPU / RAM**: Minimum 4 vCPUs, 8 GB RAM (16 GB recommended for high traffic).
- **Disk**: 40 GB+ NVMe SSD.
- **OS**: Ubuntu 22.04 LTS / 24.04 LTS with Docker & Coolify v4.11.

---

## Step 1: Resource 1 — Self-Hosted Supabase Stack

1. In Coolify, open your Project and Environment.
2. Click **+ New Resource** -> **Docker Compose** -> **From Git Repository**.
3. Select this repository (`fydio`), branch `main`.
4. Configure the resource settings:
   - **Name**: `Fydio Supabase Stack`
   - **Base Directory**: `docker`
   - **Compose Files**: `docker-compose.yml` and `docker-compose.prod.yml`
5. Configure Domains & Ports:
   - Under `api-gw` service, set domain to `https://api.<your-domain>`.
   - Leave `studio` bound to loopback or set to a separate restricted domain (e.g., `https://studio.<your-domain>`).
6. Configure Secrets & Environment Variables in Coolify's Environment UI (generate values via `pnpm secrets:generate` locally or openssl):
   ```env
   POSTGRES_PASSWORD=<strong_random_password>
   POSTGRES_DB=postgres
   POSTGRES_HOST=db
   POSTGRES_PORT=5432
   JWT_SECRET=<min_32_characters>
   JWT_EXPIRY=3600
   ANON_KEY=<hs256_anon_key_signed_with_jwt_secret>
   SERVICE_ROLE_KEY=<hs256_service_role_key_signed_with_jwt_secret>
   SECRET_KEY_BASE=<min_64_characters>
   REALTIME_DB_ENC_KEY=<exactly_16_hex_chars>
   VAULT_ENC_KEY=<exactly_32_hex_chars>
   PG_META_CRYPTO_KEY=<min_32_characters>
   IMGPROXY_KEY=<hex_string>
   SUPABASE_PUBLIC_URL=https://api.<your-domain>
   API_EXTERNAL_URL=https://api.<your-domain>
   SITE_URL=https://app.<your-domain>
   ADDITIONAL_REDIRECT_URLS=https://app.<your-domain>/**
   DISABLE_SIGNUP=true
   ENABLE_EMAIL_SIGNUP=true
   MFA_ENABLED=false
   SMTP_HOST=<smtp.provider.com>
   SMTP_PORT=587
   SMTP_USER=<smtp_username>
   SMTP_PASS=<smtp_password>
   SMTP_ADMIN_EMAIL=auth@<your-domain>
   SMTP_SENDER_NAME=Fydio
   SMTP_MAX_FREQUENCY=1m
   ```
7. Click **Deploy**. Wait for all services (`db`, `api-gw`, `auth`, `rest`, `storage`, `realtime`, `supavisor`) to report **Healthy**.

---

## Step 2: Run Production Migrations

Run database migrations against the newly running production database before deploying the web app:

```bash
# Point to your production Postgres connection string
DATABASE_URL="postgres://supabase_admin:${POSTGRES_PASSWORD}@api.<your-domain>:5432/postgres"

# Apply all migrations
supabase db push --db-url "$DATABASE_URL"
```

Verify migration status:

```bash
psql "$DATABASE_URL" -c "select public.get_migration_head();"
# Should output latest migration version (e.g., 0030)
```

---

## Step 3: Resource 2 — Next.js Web Application

1. In Coolify, click **+ New Resource** -> **Application** -> **From Git Repository**.
2. Select this repository (`fydio`), branch `main`.
3. Configure the resource settings:
   - **Name**: `Fydio Web App`
   - **Build Pack**: `Dockerfile`
   - **Base Directory**: `/` (Root directory)
   - **Dockerfile Path**: `apps/web/Dockerfile`
   - **Domain**: `https://app.<your-domain>` (Port `3000`)
4. Configure Environment Variables in Coolify:
   ```env
   NODE_ENV=production
   NEXT_PUBLIC_APP_NAME=Fydio
   NEXT_PUBLIC_APP_URL=https://app.<your-domain>
   NEXT_PUBLIC_SUPABASE_URL=https://api.<your-domain>
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY>
   SUPABASE_URL=https://api.<your-domain>
   SUPABASE_ANON_KEY=<ANON_KEY>
   SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY>
   SUPABASE_JWT_SECRET=<JWT_SECRET>
   DATABASE_URL=postgres://authenticator:${POSTGRES_PASSWORD}@db:5432/postgres
   EXTENSION_TOKEN_SECRET=<min_32_characters>
   CRON_SECRET=<min_16_characters>
   PORT=3000
   HOSTNAME=0.0.0.0
   ```
5. Configure Health Check:
   - **Healthcheck Path**: `/api/health`
   - **Expected Status**: `200`
6. Click **Deploy**. Coolify builds the multi-stage image, caches dependencies with `turbo prune`, and routes traffic via TLS.

---

## Step 4: Scheduled Tasks (Coolify Cron)

Fydio runs two automated background jobs via HTTP endpoints protected by `CRON_SECRET`. In Coolify, add scheduled cron jobs under the Web Application:

1. **Weekly Allowance Grant**:
   - **Schedule**: `0 0 * * 1` (Every Monday at midnight UTC)
   - **Command**:
     ```bash
     curl -fsS -X POST "https://app.<your-domain>/api/cron/weekly-allowance" \
       -H "Authorization: Bearer ${CRON_SECRET}"
     ```
2. **Held Credits Release Sweeper**:
   - **Schedule**: `0 * * * *` (Hourly)
   - **Command**:
     ```bash
     curl -fsS -X POST "https://app.<your-domain>/api/cron/release-held" \
       -H "Authorization: Bearer ${CRON_SECRET}"
     ```

---

## Step 5: Post-Deploy Verification

Run the smoke test script against your production deployment:

```bash
bash scripts/smoke-prod.sh https://app.<your-domain> https://api.<your-domain>
```

Verify endpoints manually:

```bash
# Gateway Auth Health
curl -fsS https://api.<your-domain>/auth/v1/health

# Web App Health + Migration Head
curl -fsS https://app.<your-domain>/api/health | jq
```
