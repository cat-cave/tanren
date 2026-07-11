FROM node:24-bookworm-slim

# podman (remote client) + the `docker`→podman shim: the worker boots the merge-reflecting
# Fly deploy builder (autonomyLoops → liveFlyImageBuilder), which shells
# `scripts/dev/build-deploy-image.sh` (`docker build` + `docker push`). In the dev stack the
# host podman socket is mounted into the worker and CONTAINER_HOST points at it, so these
# `docker` calls run as `podman --remote`, streaming the build to the host podman (which
# owns the storage + registry auth). Only the CLIENT is needed here — no local daemon.
# ca-certificates is REQUIRED alongside podman: node:24-bookworm-slim ships no system CA
# bundle, and podman verifies the deploy registry's TLS against the SYSTEM store
# (/etc/ssl/certs) — without it `docker login registry.fly.io` fails
# `x509: certificate signed by unknown authority` and the merge-reflecting build never
# pushes. (Node's own bundled CA is separate, so JS HTTPS still worked — which is why
# only the podman registry auth tripped.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends podman podman-docker ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tanren/db build && pnpm --filter @tanren/orchestrator build

EXPOSE 3100
CMD ["pnpm", "--filter", "@tanren/orchestrator", "start"]
