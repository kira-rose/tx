# TX Server Dockerfile
# Multi-stage build for smaller production image

# ============================================================================
# Stage 1: Build
# ============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ============================================================================
# Stage 2: Production
# ============================================================================
FROM node:20-alpine AS production

WORKDIR /app

# Install runtime dependencies for native modules (pg)
RUN apk add --no-cache python3 make g++

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /app/.tx && chown -R nodejs:nodejs /app/.tx

# Switch to non-root user
USER nodejs

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3847/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Expose port
EXPOSE 3847

# Default command - run server with migration
CMD ["node", "dist/tx.js", "--serve"]

