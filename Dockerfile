FROM node:18-alpine

WORKDIR /app

# Install OpenSSL required by Prisma engine on Alpine Linux
RUN apk add --no-cache openssl

# Set build environment variables so devDependencies and Prisma client build reliably
ENV NODE_ENV=development
ENV DATABASE_URL="file:./dev.sqlite"

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm ci

# Copy full application source
COPY . .

# Generate Prisma client engine
RUN npx prisma generate

# Build Remix application
RUN npm run build

# Set production environment for runtime
ENV NODE_ENV=production

# Expose default port
EXPOSE 3000

# Push Prisma schema to SQLite then start server
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npm run start"]
