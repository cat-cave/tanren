#!/usr/bin/env bash
set -euo pipefail

port_offset="${TANREN_PORT_OFFSET:-0}"
case "$port_offset" in
  *[!0-9]* | "")
    echo "TANREN_PORT_OFFSET must be a non-negative integer" >&2
    exit 2
    ;;
esac

internal_mtls_port="${TANREN_INTERNAL_MTLS_HOST_PORT:-$((3110 + port_offset))}"
postgres_port="${TANREN_POSTGRES_HOST_PORT:-$((5432 + port_offset))}"
export TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=1
export TANREN_CLAIM_ENDPOINT_SMOKE_URL="https://localhost:${internal_mtls_port}"
export TANREN_APP_DATABASE_URL="${TANREN_APP_DATABASE_URL:-postgres://tanren_app:tanren_app@localhost:${postgres_port}/tanren}"
export TANREN_DATAPLANE_DATABASE_URL="${TANREN_DATAPLANE_DATABASE_URL:-postgres://tanren_dataplane:tanren_dataplane@localhost:${postgres_port}/tanren}"
export DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:${postgres_port}/tanren}"

if [ "${TANREN_SMOKE_REMOTE_WRITES_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' \
    "TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=${TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE}" \
    "TANREN_DATAPLANE_DATABASE_URL=${TANREN_DATAPLANE_DATABASE_URL}" \
    "TANREN_SMOKE_REMOTE_WRITES_PROBE=scripts/smoke/plane-split-worker.ts"
  exit 0
fi

exec corepack pnpm exec tsx scripts/smoke/plane-split-worker.ts
