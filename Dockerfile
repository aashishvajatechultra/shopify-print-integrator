FROM node:18-alpine
WORKDIR /app

# Install OpenSSL required by Prisma engine on Alpine Linux
RUN apk add --no-cache openssl

# Install all dependencies (including devDependencies required for remix/vite build)
COPY package*.json ./
RUN npm ci --include=dev


# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build Remix app
RUN npm run build

# Expose default port
EXPOSE 3000

# Run db push then start server
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npm run start"]



 
