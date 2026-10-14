# syntax=docker/dockerfile:1

# ---- Build stage ---------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/agui-profile/package.json packages/agui-profile/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- Runtime stage -------------------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/agui-profile/package.json packages/agui-profile/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/agui-profile/dist ./packages/agui-profile/dist
COPY --from=builder /app/dist ./dist
COPY schemas ./schemas
COPY agent-packs/example ./agent-packs/example
COPY agent-packs/welcome ./agent-packs/welcome
USER node
EXPOSE 3010
CMD ["node", "dist/index.js"]
