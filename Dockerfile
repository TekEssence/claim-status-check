# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npx --yes playwright@1.61.1 install-deps chromium \
    && mkdir -p /ms-playwright \
    && chown -R node:node /ms-playwright /app \
    && npm cache clean --force

USER node

RUN npx --yes playwright@1.61.1 install chromium \
    && npm cache clean --force

USER root

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder

COPY . .
RUN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
    DB_SSL=false \
    AUTH_SESSION_SECRET=build-only-secret \
    BETTER_AUTH_SECRET=build-only-secret \
    BETTER_AUTH_URL=http://localhost:3000 \
    npm run build:docker
RUN npm prune --omit=dev

FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    BROWSER_HEADLESS=true \
    BROWSER_KEEP_OPEN=false

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

RUN mkdir -p /app/data /app/incoming /tmp/iehp-scrape-artifacts \
    && chown -R node:node /app/data /app/incoming /tmp/iehp-scrape-artifacts

USER node

EXPOSE 3000

CMD ["node", "server.js"]
