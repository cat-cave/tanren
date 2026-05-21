FROM node:24-bookworm-slim

WORKDIR /app

COPY . .
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tanren/db build && pnpm --filter @tanren/dashboard build

EXPOSE 3000
CMD ["pnpm", "--filter", "@tanren/dashboard", "start"]
