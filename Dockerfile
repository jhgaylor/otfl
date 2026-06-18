# syntax=docker/dockerfile:1

# ---- builder: compile native deps (better-sqlite3) ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
# build-essential + python3 cover the case where no prebuilt better-sqlite3
# binary exists for the target platform; with prebuilds present this is a no-op.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
