# ── Stage 1: Build frontend + backend ─────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Install ALL dependencies (dev included, needed for tsc & prisma)
COPY package.json package-lock.json* ./
COPY prisma/ ./prisma/
RUN npm ci && npx prisma generate

# Copy source and build both frontend and backend
COPY . .
RUN npm run build && npm run build:backend

# ── Stage 2: Production runtime ──────────────────────────────────
FROM node:20-alpine AS production

# Security: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install only production dependencies + generate Prisma client
COPY package.json package-lock.json* ./
COPY prisma/ ./prisma/
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

# Copy server code
COPY server/ ./server/

# Copy compiled backend (TypeScript → JS)
COPY --from=build /app/backend/dist ./backend/dist

# Copy built frontend from build stage
COPY --from=build /app/dist ./dist

# Switch to non-root user
USER appuser

# Expose the port (default 3000, overridable via PORT env)
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Health check – Docker / orchestrator can use this
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["node", "server/index.js"]
