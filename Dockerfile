# ============================================================
# Stage 1 — build
# ============================================================
FROM node:22-slim AS builder

# Install native build tools needed by optional dependencies
# (e.g. @silvia-odwyer/photon-node)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer 1: dependency manifests (changes rarely → good cache hit rate)
COPY package.json package-lock.json ./
RUN npm ci

# Layer 2: config (almost never changes)
COPY tsconfig.json next.config.ts postcss.config.mjs tailwind.config.ts ./

# Layer 3: source code (changes frequently → invalidates only this layer)
COPY app/       ./app
COPY components/ ./components
COPY hooks/     ./hooks
COPY lib/       ./lib
COPY public/    ./public

RUN npm run build

# ============================================================
# Stage 2 — production image
# ============================================================
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Copy built app + node_modules
COPY --from=builder /app/.next        ./.next
COPY --from=builder /app/public      ./public
COPY --from=builder /app/package.json       ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/next.config.ts   ./

# Install production dependencies (devDeps excluded)
RUN npm ci --omit=dev --ignore-scripts

# Re-build native optional deps (they were skipped with --ignore-scripts)
RUN npm rebuild

ENV HOME=/home/node

RUN chown -R node:node /home/node

USER node

EXPOSE 30141

CMD ["node_modules/.bin/next", "start", "-p", "30141"]
