FROM node:22-alpine

WORKDIR /app

# Install dependencies first (better docker layer cache)
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy source code and build
COPY src/ ./src/
RUN npm run build

# Drop dev-only dependencies (typescript, tsx) from the final image
RUN npm prune --omit=dev
ENV NODE_ENV=production

# Expose port for health check
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
