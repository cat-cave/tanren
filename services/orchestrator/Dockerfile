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
#
# CLIENT/SERVER MAJOR MUST MATCH: the worker dials the HOST podman SERVICE over
# CONTAINER_HOST. bookworm's apt podman is 4.3.1; the host runs podman 5.x. A 4.x client
# against a 5.x service mis-parses the push-results stream ("failed to parse push results
# stream, unexpected input: { }") and exits 125 on `podman push` — and the manifest does
# NOT reliably land, so the merge-reflecting deploy fails intermittently. Install the static
# podman-remote 5.x client (remote-only — exactly what the worker needs) OVER the apt 4.3.1
# so the majors match and `podman push` exits 0 reliably. `podman-docker` (the `docker`→
# `/usr/bin/podman` shim) + ca-certificates still come from apt; curl fetches the binary.
ARG PODMAN_REMOTE_VERSION=5.8.2
RUN apt-get update \
  && apt-get install -y --no-install-recommends podman-docker ca-certificates curl \
  && update-ca-certificates \
  && curl -fsSL -o /tmp/podman-remote.tgz \
       "https://github.com/containers/podman/releases/download/v${PODMAN_REMOTE_VERSION}/podman-remote-static-linux_amd64.tar.gz" \
  && tar xzf /tmp/podman-remote.tgz -C /tmp \
  && install -m 0755 /tmp/bin/podman-remote-static-linux_amd64 /usr/bin/podman \
  && rm -rf /tmp/podman-remote.tgz /tmp/bin \
  && rm -rf /var/lib/apt/lists/* \
  && podman --version

WORKDIR /app

COPY . .
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tanren/db build && pnpm --filter @tanren/orchestrator build

ARG TANREN_SOURCE_REVISION=unbound
ARG TANREN_SOURCE_TREE=unbound
ARG TANREN_SMOKE_BUILD_ID=unbound
ARG TANREN_SMOKE_SERVICE=unbound
LABEL org.opencontainers.image.revision="${TANREN_SOURCE_REVISION}" \
  io.tanren.source-tree="${TANREN_SOURCE_TREE}" \
  io.tanren.smoke.build-id="${TANREN_SMOKE_BUILD_ID}" \
  io.tanren.smoke.service="${TANREN_SMOKE_SERVICE}"
RUN printf '%s\n' "${TANREN_SOURCE_REVISION}" > /etc/tanren-source-revision

EXPOSE 3100
CMD ["pnpm", "--filter", "@tanren/orchestrator", "start"]
