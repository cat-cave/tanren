#!/usr/bin/env bash
# Golden-image build pipeline (environment-management.md §3 Layer 3 + §7 P2).
#
# Builds the runner image — the GOLDEN BASE: the neutral sandbox + Tanren's harness
# + `mise` + the WARM mise BASELINE (runner/mise.baseline.toml, pre-warmed into the
# shared /opt/tanren/mise data dir so a common project's `mise install` is a warm
# CACHE HIT, not a cold download) — via BuildKit (`docker buildx build`), with
# REGISTRY-backed build cache (`--cache-to/--cache-from type=registry,mode=max`) and
# a CONTENT-DIGEST tag so the same inputs produce the same identity.
#
# This is the build half of P2. It is runnable LOCALLY against the dev registry
# (`registry:2` in compose.dev.yml, published on host :5000 — `just up-dev`), and is
# the SAME recipe the refresh-on-`main` GitHub workflow (.github/workflows/
# golden-image.yml) invokes. P3 (env registry) resolves images from the registry
# this pushes to; P2 only builds + pushes + tags.
#
# Env knobs (all defaulted for local dev — CI overrides REGISTRY + PUSH):
#   REGISTRY   registry host[:port][/ns] to tag/cache against (default localhost:5000)
#   IMAGE_NAME image repo name under the registry            (default tanren-runner)
#   PUSH       1 → push the built image + cache to REGISTRY  (default 0; build local)
#   PLATFORMS  buildx target platforms                       (default host arch)
#   EXTRA_TAGS space-separated extra tags to also apply (e.g. a channel like `lts`)
#
# CONTENT-DIGEST TAG: the tag is `golden-<digest>` where <digest> is a sha256 over
# the inputs that DEFINE the image (the Dockerfile, the entrypoint, the baseline
# spec). It is a CONTENT key (same inputs → same tag → cache/registry HIT), the P2
# half of the env_key the design layers on top (env_key = hash(base_digest ‖ lock…)
# is computed per-project in P3, NOT here).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

REGISTRY="${REGISTRY:-localhost:5000}"
IMAGE_NAME="${IMAGE_NAME:-tanren-runner}"
PUSH="${PUSH:-0}"
EXTRA_TAGS="${EXTRA_TAGS:-}"

DOCKERFILE="runner/Dockerfile"

# Content digest over the image-DEFINING inputs. Anything that changes WHAT the
# golden base is (the Dockerfile recipe, the entrypoint baked in, the warm-baseline
# toolchain spec) flips the digest; an unrelated repo change does NOT. This is the
# refresh trigger's path-filter mirror (golden-image.yml watches the same files).
CONTENT_DIGEST="$(
  cat "$DOCKERFILE" runner/entrypoint.sh runner/mise.baseline.toml \
    | sha256sum | awk '{print $1}'
)"
DIGEST_TAG="golden-${CONTENT_DIGEST:0:16}"

IMAGE_REF="${REGISTRY}/${IMAGE_NAME}:${DIGEST_TAG}"
CACHE_REF="${REGISTRY}/${IMAGE_NAME}:buildcache"

echo "[build-golden-image] repo            : ${REPO_ROOT}"
echo "[build-golden-image] registry        : ${REGISTRY}"
echo "[build-golden-image] content digest  : ${CONTENT_DIGEST}"
echo "[build-golden-image] image ref       : ${IMAGE_REF}"
echo "[build-golden-image] push            : ${PUSH}"

# A dedicated buildx builder with the docker-container driver — REQUIRED for
# registry cache export (`--cache-to type=registry`); the default `docker` driver
# cannot export inline registry cache. Created idempotently.
#
# Two dev-registry accommodations are baked into the builder:
#   - network=host: the docker-container builder runs in its OWN net namespace, so
#     a `localhost:5000` ref would resolve to the BUILDER's loopback, not the host
#     registry. Host networking lets it reach the host-published dev registry. (In
#     CI against a real HTTPS registry this is harmless.)
#   - insecure registry config: the dev `registry:2` serves PLAIN HTTP, which
#     BuildKit refuses by default. A buildkitd.toml marks REGISTRY's host as
#     insecure (http=true). Only applied for an http-style host (a real CI registry
#     is HTTPS and needs neither). The config is regenerated to match REGISTRY.
BUILDER="tanren-golden"
REGISTRY_HOST="${REGISTRY%%/*}"
BUILDKITD_CONFIG="$(mktemp -t tanren-golden-buildkitd.XXXXXX.toml)"
trap 'rm -f "$BUILDKITD_CONFIG"' EXIT
cat > "$BUILDKITD_CONFIG" <<EOF
[registry."${REGISTRY_HOST}"]
  http = true
  insecure = true
EOF

# Recreate the builder each run so a changed REGISTRY host (dev ↔ CI) re-applies the
# matching insecure-registry config; cheap (the container is reused for the build).
docker buildx rm "$BUILDER" >/dev/null 2>&1 || true
echo "[build-golden-image] creating buildx builder '${BUILDER}' (docker-container driver, network=host)"
docker buildx create \
  --name "$BUILDER" \
  --driver docker-container \
  --driver-opt network=host \
  --buildkitd-config "$BUILDKITD_CONFIG" \
  --use >/dev/null

# Assemble the buildx args. We always pull cache FROM the registry (warm CI/local
# rebuilds). We only push the image + export cache TO the registry when PUSH=1
# (CI / an explicit local push to the dev registry); a bare local build loads the
# image into the local docker store instead (`--load`).
TAG_ARGS=(--tag "$IMAGE_REF")
for t in $EXTRA_TAGS; do
  TAG_ARGS+=(--tag "${REGISTRY}/${IMAGE_NAME}:${t}")
done

OUTPUT_ARGS=()
CACHE_TO_ARGS=()
if [ "$PUSH" = "1" ]; then
  OUTPUT_ARGS=(--push)
  # mode=max caches EVERY layer (incl. intermediate), so the expensive toolchain
  # + warm-baseline downloads become cache hits on the next refresh.
  CACHE_TO_ARGS=(--cache-to "type=registry,ref=${CACHE_REF},mode=max")
else
  OUTPUT_ARGS=(--load)
fi

PLATFORM_ARGS=()
if [ -n "${PLATFORMS:-}" ]; then
  PLATFORM_ARGS=(--platform "$PLATFORMS")
fi

set -x
docker buildx build \
  --builder "$BUILDER" \
  --file "$DOCKERFILE" \
  "${TAG_ARGS[@]}" \
  "${PLATFORM_ARGS[@]}" \
  --cache-from "type=registry,ref=${CACHE_REF}" \
  "${CACHE_TO_ARGS[@]}" \
  "${OUTPUT_ARGS[@]}" \
  "$REPO_ROOT"
set +x

echo "[build-golden-image] built ${IMAGE_REF}"
if [ "$PUSH" = "1" ]; then
  echo "[build-golden-image] pushed ${IMAGE_REF} (+ cache ${CACHE_REF}, mode=max) to ${REGISTRY}"
else
  echo "[build-golden-image] loaded ${IMAGE_REF} into the local docker store (PUSH=0)"
fi
# Emit the content-digest tag on the LAST line so callers (CI / P3) can capture it.
echo "${DIGEST_TAG}"
