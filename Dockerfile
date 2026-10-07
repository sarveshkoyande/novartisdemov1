# Multi-stage build: React client (future UI) + Express/Prisma server
# (the actual app that's live today). See server/server.js — production
# static-serve still points at public/index.html (the working single-file
# mock) until the real UI is ported into client/ in Phase 2+; this build
# already produces client/dist so that swap is a one-line change later,
# not a re-plumb of the whole deployment pipeline.

FROM node:20-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:20-bookworm-slim AS server
# better-sqlite3 needs a native build toolchain at install time.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
RUN npx prisma generate
COPY public/ ../public/
# Staged for the Phase 2+ cutover — not yet served.
COPY --from=client-build /app/client/dist ./client-dist
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 4300
ENTRYPOINT ["./docker-entrypoint.sh"]
