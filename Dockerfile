# ── Stage 1: Build the Vite frontend ──────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# ── Stage 2: Production runtime ──────────────────────────────────
FROM node:20-alpine AS production

# Security: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy server code
COPY server/ ./server/

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
