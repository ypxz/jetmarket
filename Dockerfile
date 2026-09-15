# JetMarket web image — build context is the repo root:
#   docker build -t jetmarket-web .
# Run:  docker run -p 3000:3000 --env-file .env.local jetmarket-web
# Requires `output: "standalone"` in apps/web/next.config.ts.

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @jetmarket/web build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# Next standalone output keeps the monorepo layout: server entry lives under apps/web.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
