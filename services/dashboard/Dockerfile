FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tanren/db build && pnpm --filter @tanren/dashboard build

EXPOSE 3000
CMD ["pnpm", "--filter", "@tanren/dashboard", "start"]
