#!/usr/bin/env bash
# Live Fly deploy-image build (PR3). The deploy-layer counterpart of
# build-env-image.sh: it builds the MERGED COMMIT's source (fetched + extracted by
# liveFlyImageBuilder.ts) into `registry.fly.io/<app>:<sha>` on the ORCHESTRATOR HOST
# and PUSHES it, so a Fly release (`flyDeployProvisioner.triggerDeploy`) runs a
# MERGE-REFLECTING image instead of a static grant image.
#
# REUSE the BuildKit doctrine: docker buildx build, then docker push. Unlike build-env-image.sh
# (which targets an insecure localhost dev registry and needs a docker-container
# builder + insecure-registry config), registry.fly.io is a real HTTPS registry, so
# the DEFAULT builder + a plain --push suffice. No cache-export complexity: per-SHA
# tags are write-once (a SHA never changes), so there is no layer-cache amortization
# across distinct images to engineer here.
#
# SECRET DISCIPLINE: FLY_TOKEN is the Fly API token (it doubles as the registry push
# password). It arrives via ENV (set by liveFlyImageBuilder.ts), NEVER argv, and is fed
# to `docker login` over STDIN (--password-stdin) so it never appears in `ps`/`set -x`.
# The script never echoes it; the only stdout the driver reads is the final IMAGE REF.
#
# Env knobs (all REQUIRED):
#   APP       the Fly app slug (registry namespace, e.g. tanren-acme-web)
#   SHA       the merged git ref (the per-commit tag)
#   FLY_TOKEN the Fly API token (registry push password) — via env, never argv
#   CONTEXT   the build-context dir (the extracted merged-commit source + a Dockerfile)
#
# Emits the pushed IMAGE REF on the LAST line so liveFlyImageBuilder.ts captures it.
set -euo pipefail

APP="${APP:?APP is required - the Fly app slug (registry namespace)}"
SHA="${SHA:?SHA is required - the merged git ref (per-commit tag)}"
FLY_TOKEN="${FLY_TOKEN:?FLY_TOKEN is required - the Fly API token (registry push password)}"
CONTEXT="${CONTEXT:?CONTEXT is required - the build-context dir}"

# Fail LOUD if the context has no Dockerfile — a merged commit with no Dockerfile
# cannot be built into a Fly image (no build recipe). Never a silent skip.
if [ ! -f "$CONTEXT/Dockerfile" ]; then
  echo "[build-deploy-image] no Dockerfile in context: ${CONTEXT}" >&2
  exit 1
fi

IMAGE_REF="registry.fly.io/${APP}:${SHA}"

echo "[build-deploy-image] app            : ${APP}"
echo "[build-deploy-image] sha            : ${SHA}"
echo "[build-deploy-image] context        : ${CONTEXT}"
echo "[build-deploy-image] image ref      : ${IMAGE_REF}"

# Log into the Fly registry. The token is fed over STDIN (never argv / never echoed):
# `set -x` is OFF for this block so the here-string does not leak the token into logs.
# Fly's registry authenticates with username `x` + the Fly API token as the password.
docker login registry.fly.io -u x --password-stdin <<< "$FLY_TOKEN" >&2

# Build the per-commit image, THEN push it — in TWO steps, and with plain `docker build`
# (NOT `docker buildx build`), deliberately, for maximum portability across the runtimes
# this must work on:
#   • real docker (host or daemon)              — `docker build` = classic/buildkit, fine
#   • podman on the host (`docker`→podman shim) — `docker build` = `podman build`, fine
#   • podman-REMOTE from the worker container    — `docker build` = `podman build` streaming
#     the context to the host podman over the mounted socket (CONTAINER_HOST). buildkit's
#     `docker buildx` is NOT served by podman's API socket, so buildx-over-socket fails;
#     classic `docker build` IS. And buildkit's `--push` convenience flag is unsupported by
#     podman's buildx shim anyway (`Error: unknown flag: --push`) — hence build-then-push.
# `--tag` (no `--push`) leaves the tagged image in the (host) storage; `docker push` uploads
# it. NO wall-clock timeout (feedback_no_timeouts_progress_based): each step runs to its own
# terminal exit; a non-zero exit surfaces LOUD to the driver (FlyImageBuildFailedError).
set -x
# --security-opt seccomp=unconfined: podman-REMOTE resolves the seccomp profile by PATH on
# the CLIENT (the worker's Debian default /usr/share/containers/seccomp.json) and passes that
# path to the SERVICE (the host podman), which on a non-Debian host (e.g. NixOS) does not have
# it → `opening seccomp profile failed: no such file`. Running the build unconfined avoids the
# client/server path mismatch entirely; it is safe here — the build RUN steps compile the
# MERGED, CI-gated product source, not arbitrary input, and the result is a throwaway image.
docker build \
  --security-opt seccomp=unconfined \
  --file "$CONTEXT/Dockerfile" \
  --tag "$IMAGE_REF" \
  "$CONTEXT"
# Push. The push exit code is trustworthy ONLY when the podman client major matches the
# service it dials over CONTAINER_HOST. A 4.x client against a 5.x service mis-parses the
# push-results stream ("failed to parse push results stream, unexpected input: { }") and
# exits 125 — and the manifest does NOT reliably land, so the exit code is a genuine failure
# signal, not cosmetic. The worker image pins a matching podman-remote 5.x client (see
# services/orchestrator/Dockerfile), so a non-zero push here is a REAL failure — fail loud
# (set -e) rather than mask it behind an unreliable post-push probe (`podman pull` reads
# LOCAL storage and `manifest inspect` only handles multi-arch lists — neither is a sound
# registry-presence check).
if command -v podman >/dev/null 2>&1; then
  podman push "$IMAGE_REF"
else
  docker push "$IMAGE_REF"
fi
set +x

echo "[build-deploy-image] built + pushed ${IMAGE_REF}"
# Emit the image ref on the LAST line so liveFlyImageBuilder.ts captures it.
echo "${IMAGE_REF}"
