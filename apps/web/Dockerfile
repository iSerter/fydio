# =============================================================================
# Multi-stage Dockerfile for @fydio/web (Next.js 16 Standalone)
# =============================================================================

# ---- Base ----
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.5.2 --activate
RUN pnpm add -g turbo@2.11.7
WORKDIR /repo

# ---- Pruner (prune monorepo down to @fydio/web and dependencies) ----
FROM base AS pruner
COPY . .
RUN turbo prune @fydio/web --docker

# ---- Deps (install dependencies based on pruned lockfile and manifests) ----
FROM base AS deps
COPY --from=pruner /repo/out/json/ .
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- Builder ----
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Provide build-time fallback defaults for static build env validation
ARG NEXT_PUBLIC_APP_NAME="Fydio"
ARG NEXT_PUBLIC_APP_URL="http://localhost:3000"
ARG NEXT_PUBLIC_SUPABASE_URL="http://localhost:8000"
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy-key-for-build-time-only"
ARG NEXT_PUBLIC_EXTENSION_ID=""
ARG SUPABASE_URL="http://localhost:8000"
ARG SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy-key-for-build-time-only"
ARG SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy-key-for-build-time-only"
ARG SUPABASE_JWT_SECRET="super-secret-jwt-token-must-be-at-least-32-chars-long"

ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_EXTENSION_ID=$NEXT_PUBLIC_EXTENSION_ID
ENV SUPABASE_URL=$SUPABASE_URL
ENV SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
ENV SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
ENV SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET

COPY --from=deps /repo /repo
COPY --from=pruner /repo/out/full/ .

# Turbo automatically runs ^build first to build workspace packages (@fydio/domain, @fydio/supabase, etc.)
RUN turbo run build --filter=@fydio/web

# ---- Runner ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

WORKDIR /app

# Copy standalone build output and static assets
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
