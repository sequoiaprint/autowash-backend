FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Full install: the prisma CLI (a dev dependency) runs the migration when the container starts.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --include=dev

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

EXPOSE 4100
# Applies pending migrations (never resets data), then starts the server.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
