# --- Build Stage ---
FROM node:20-slim AS builder

WORKDIR /app

# Install openssl for Prisma client generation
RUN apt-get update -y && apt-get install -y openssl

# Copy package definitions and prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies and generate the Prisma Client
RUN npm ci
RUN npx prisma generate

# --- Production Stage ---
FROM node:20-slim

WORKDIR /app

# Install openssl in the production runtime environment
RUN apt-get update -y && apt-get install -y openssl

# Copy runtime dependencies and Prisma client
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY prisma ./prisma/
COPY src ./src/

# Environment configurations
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["npm", "start"]
