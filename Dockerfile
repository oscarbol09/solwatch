# syntax=docker/dockerfile:1.7

FROM node:24.18.0-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.18.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/app/data/solwatch.db

RUN addgroup -g 10001 -S appgroup && adduser -u 10001 -S appuser -G appgroup

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && rm -rf /root/.npm /tmp/*

COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data && chown 10001:10001 /app/data && chmod 700 /app/data

USER 10001:10001

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz', { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/index.js"]
