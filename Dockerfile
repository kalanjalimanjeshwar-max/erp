# ==============================================================================
# CoreERP Production Dockerfile (Multi-stage Build)
# ==============================================================================

# --- Stage 1: Build & Assets Compilation ---
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache libc6-compat openssl

# Copy package descriptors
COPY package*.json ./
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY prisma ./prisma/

# Install all dependencies (including dev)
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Copy application source
COPY index.html ./
COPY src ./src/
COPY server.ts ./

# Compile frontend static bundles
RUN npm run build

# --- Stage 2: Production Runtime ---
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install runtime dependencies (OpenSSL required by Prisma engine)
RUN apk add --no-cache libc6-compat openssl curl

# Create non-root application user for container security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 erpuser

# Copy built application and generated Prisma client from builder with proper non-root ownership
COPY --chown=erpuser:nodejs --from=builder /app/package*.json ./
COPY --chown=erpuser:nodejs --from=builder /app/node_modules ./node_modules
COPY --chown=erpuser:nodejs --from=builder /app/prisma ./prisma
COPY --chown=erpuser:nodejs --from=builder /app/dist ./dist
COPY --chown=erpuser:nodejs --from=builder /app/server.ts ./
COPY --chown=erpuser:nodejs --from=builder /app/src/server ./src/server
COPY --chown=erpuser:nodejs --from=builder /app/src/shared ./src/shared

# Ensure appropriate ownership
USER erpuser

EXPOSE 3000

# Health check probing process health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Production startup command
CMD ["npm", "start"]
