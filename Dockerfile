# ── Stage 1: Build frontend + backend ─────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Install ALL dependencies (dev included, needed for tsc & vite)
COPY package.json package-lock.json* ./
COPY prisma/ ./prisma/
RUN npm ci

# Copy source and run unified build (prisma generate + vite + tsc)
COPY . .
RUN npm run build

# ── Stage 2: Production runtime ──────────────────────────────────
FROM node:20-alpine AS production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install production dependencies + generate Prisma client
COPY package.json package-lock.json* ./
COPY prisma/ ./prisma/
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

# Copy server code
COPY server/ ./server/

# Copy compiled backend (TypeScript → JS)
COPY --from=build /app/backend/dist ./backend/dist

# Copy built frontend from build stage
COPY --from=build /app/dist ./dist

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

# Push schema to DB (non-interactive, tolerant of failure) then start server
CMD ["sh", "-c", "echo \"=== ENV CHECK ===\"; echo \"DATABASE_URL set: $(test -n \"$DATABASE_URL\" && echo YES || echo NO)\"; echo \"NODE_ENV: $NODE_ENV\"; echo \"================\"; npx prisma db push --skip-generate --accept-data-loss 2>&1 || echo 'WARN: prisma db push failed — server will start anyway'; exec node server/index.js"]
