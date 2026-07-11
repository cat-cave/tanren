#!/usr/bin/env bash
# Live Fly deploy-image build (PR3). The deploy-layer counterpart of
# build-env-image.sh: it builds the MERGED COMMIT's source (fetched + extracted by
# liveFlyImageBuilder.ts) into `registry.fly.io/<app>:<sha>` on the ORCHESTRATOR HOST
# and PUSHES it, so a Fly release (`flyDeployProvisioner.triggerDeploy`) runs a
# MERGE-REFLECTING image instead of a static grant image.
#
# REUSE the BuildKit doctrine: docker buildx build --push. Unlike build-env-image.sh
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

# Build + push the per-commit image. NO wall-clock timeout (feedback_no_timeouts_progress_based):
# the build runs to its own terminal exit; a non-zero exit surfaces LOUD to the driver
# (FlyImageBuildFailedError). The default buildx builder is fine for an HTTPS registry.
set -x
docker buildx build \
  --file "$CONTEXT/Dockerfile" \
  --tag "$IMAGE_REF" \
  --push \
  "$CONTEXT"
set +x

echo "[build-deploy-image] built + pushed ${IMAGE_REF}"
# Emit the image ref on the LAST line so liveFlyImageBuilder.ts captures it.
echo "${IMAGE_REF}"
