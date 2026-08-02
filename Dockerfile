FROM node:22.5.0-alpine

# Install dependencies required by Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Set working directory
WORKDIR /app

# Copy package files (build context is the repo ROOT, so we reach into backend/)
COPY backend/package.json backend/package-lock.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY backend/server.js backend/db.js backend/queue.js ./

# Create directory for SQLite database
RUN mkdir -p /app/data

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Set environment variable for Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Start application
CMD ["node", "--experimental-sqlite", "server.js"]
