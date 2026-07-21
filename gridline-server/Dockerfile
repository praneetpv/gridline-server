FROM node:20-alpine

WORKDIR /app

# Install production deps only (pg-mem / socket.io-client are dev/test-only and skipped here).
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4000

# Run the migration (idempotent — every statement in 001_init.sql is "create table if not exists")
# then start the server. Safe to run on every container start/restart.
CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]
