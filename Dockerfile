# Build stage: install the locked dependencies and compile TypeScript.
# Use the same Node version pinned for this project.
FROM node:22.23.1-bookworm-slim AS build

WORKDIR /app

# Copy dependency manifests first so Docker can reuse the npm install layer
# when application code changes but dependencies do not.
COPY package.json package-lock.json ./
RUN npm ci

# Compile the ingestion job and application services into dist/.
COPY tsconfig.json ./
COPY jobs ./jobs
COPY services ./services
RUN npm run build

# Remove build-only packages before copying dependencies into the final image.
RUN npm prune --omit=dev

# Runtime stage: carry only compiled code and production dependencies.
FROM node:22.23.1-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Compose selects either the retriever or API entry point.
# It mounts the local index and SPIRE Workload API socket at runtime;
# neither the index nor SPIRE credentials are baked into this image.