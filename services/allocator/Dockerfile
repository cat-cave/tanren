FROM node:24-bookworm-slim

WORKDIR /app

COPY . .
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tanren/db build && pnpm --filter @tanren/allocator build

ARG TANREN_SOURCE_REVISION=unbound
ARG TANREN_SOURCE_TREE=unbound
ARG TANREN_SMOKE_BUILD_ID=unbound
ARG TANREN_SMOKE_SERVICE=unbound
LABEL org.opencontainers.image.revision="${TANREN_SOURCE_REVISION}" \
  io.tanren.source-tree="${TANREN_SOURCE_TREE}" \
  io.tanren.smoke.build-id="${TANREN_SMOKE_BUILD_ID}" \
  io.tanren.smoke.service="${TANREN_SMOKE_SERVICE}"
RUN printf '%s\n' "${TANREN_SOURCE_REVISION}" > /etc/tanren-source-revision

EXPOSE 3200
CMD ["pnpm", "--filter", "@tanren/allocator", "start"]
