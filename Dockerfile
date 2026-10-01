# Deskzo One — the app server's image. The same image runs the platform worker (see the end).
#
# Not Next's "standalone" output: the running app also needs the Prisma CLI (setting up a new
# workspace runs `prisma migrate deploy` against its fresh database), tsx (the worker and the
# reference-data syncs), the migrations, scripts/ and src/. So the image holds the whole built
# project, with node_modules as `npm ci` installed it.
#
# Build arguments:
#   PG_MAJOR          the PostgreSQL server's major version. pg_dump refuses a server newer than
#                     itself, and backups run pg_dump, so match the database (default 16).
#   BUILD_MEMORY_MB   Node's heap for `next build`; the type check needs more than the default.

ARG NODE_VERSION=24
ARG PG_MAJOR=16

# ─── Base ─────────────────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Prisma reads the OpenSSL version to choose its query engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ─── Dependencies ─────────────────────────────────────────────────────────────────────────────────
# Only what `npm ci` reads, so this layer is reused until the dependencies change. Its postinstall
# generates the control-plane and reference clients, which needs their schemas and configs.
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma.config.ts prisma.control.config.ts prisma.reference.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/control/schema.prisma ./prisma/control/schema.prisma
COPY prisma/reference/schema.prisma ./prisma/reference/schema.prisma
RUN npm ci --no-audit --no-fund

# ─── Build ────────────────────────────────────────────────────────────────────────────────────────
FROM deps AS builder
ARG BUILD_MEMORY_MB=8192
COPY . .
# All three Prisma clients, again: an install can prune a generated client.
RUN npm run db:generate
RUN NODE_OPTIONS="--max-old-space-size=${BUILD_MEMORY_MB}" npm run build \
  && rm -rf .next/cache

# ─── Runtime ──────────────────────────────────────────────────────────────────────────────────────
FROM base AS runner
ARG PG_MAJOR

# pg_dump, pg_restore and psql for backups and restores, from PostgreSQL's own repository so the
# version matches the server; Chromium for the PDFs attached to mailed invoices and quotes; tini
# so signals reach Node and the processes it starts are reaped.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && . /etc/os-release \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-client-${PG_MAJOR} \
    chromium fonts-liberation fonts-dejavu-core \
    tini \
  && apt-get purge -y --auto-remove curl gnupg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    PDF_BROWSER_PATH=/usr/bin/chromium \
    PDF_BROWSER_NO_SANDBOX=true \
    BACKUP_DIR=/data/backups \
    SUPPORT_DIR=/data/support \
    GEOIP_DIR=/data/geoip

# Chromium's sandbox needs kernel features a container doesn't give an unprivileged user. It only
# ever opens this app's own print pages, which is why it may run without one.

COPY --from=builder --chown=node:node /app /app

# /data is the one directory to keep on a persistent volume: workspace backups, support
# attachments, the GeoIP file. Everything else in the container is rebuilt on every deploy.
RUN mkdir -p /data/backups /data/support /data/geoip /app/.next/cache /app/platform-outbox \
  && chown -R node:node /data /app/.next/cache /app/platform-outbox

USER node
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
# The web app: every workspace, the website, the console, the CMS and the partner portal.
# The worker runs from this same image with the command: node_modules/.bin/tsx scripts/platform-worker.ts
CMD ["node_modules/.bin/next", "start"]
