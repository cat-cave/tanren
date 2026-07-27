#!/usr/bin/env bash
set -euo pipefail

port_offset="${TANREN_PORT_OFFSET:-0}"
if ! printf '%s\n' "$port_offset" | grep -Eq '^[+-]?[0-9]+$'; then
  echo "TANREN_PORT_OFFSET must be a signed integer" >&2
  exit 2
fi
offset_digits="${port_offset#[-+]}"
port_offset_num=$((10#$offset_digits))
case "$port_offset" in
  -*) port_offset_num=$((-port_offset_num)) ;;
esac

internal_mtls_port="${TANREN_INTERNAL_MTLS_HOST_PORT:-$((3110 + port_offset_num))}"
postgres_port="${TANREN_POSTGRES_HOST_PORT:-$((5432 + port_offset_num))}"
for port_name in internal_mtls_port postgres_port; do
  port_value="${!port_name}"
  if ! printf '%s\n' "$port_value" | grep -Eq '^[0-9]+$'; then
    echo "derived internal mTLS and Postgres ports must be integers" >&2
    exit 2
  fi
  printf -v "$port_name" '%d' "$((10#$port_value))"
done
if (( internal_mtls_port < 1 || internal_mtls_port > 65535 || postgres_port < 1 || postgres_port > 65535 )); then
  echo "derived internal mTLS and Postgres ports must be in 1..65535" >&2
  exit 2
fi
export TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=1
export TANREN_CLAIM_ENDPOINT_SMOKE_URL="https://localhost:${internal_mtls_port}"
export TANREN_APP_DATABASE_URL="${TANREN_APP_DATABASE_URL:-postgres://tanren_app:tanren_app@localhost:${postgres_port}/tanren}"
export TANREN_DATAPLANE_DATABASE_URL="${TANREN_DATAPLANE_DATABASE_URL:-postgres://tanren_dataplane:tanren_dataplane@localhost:${postgres_port}/tanren}"
export DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:${postgres_port}/tanren}"

if [ "${TANREN_SMOKE_REMOTE_WRITES_DRY_RUN:-0}" = "1" ]; then
  redacted_dataplane_url="$TANREN_DATAPLANE_DATABASE_URL"
  case "$redacted_dataplane_url" in
    *://*@*)
      scheme="${redacted_dataplane_url%%://*}://"
      remainder="${redacted_dataplane_url#*://}"
      before_query="${remainder%%[?#]*}"
      query_suffix="${remainder#"$before_query"}"
      authority="${before_query%%/*}"
      userinfo_candidate="${before_query%%@*}"
      if [[ "$authority" == *@* || ( "$before_query" == *@* && "$userinfo_candidate" == *:* ) ]]; then
        redacted_dataplane_url="${scheme}REDACTED@${before_query##*@}${query_suffix}"
      fi
      ;;
  esac
  printf '%s\n' \
    "TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=${TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE}" \
    "TANREN_DATAPLANE_DATABASE_URL=${redacted_dataplane_url}" \
    "TANREN_SMOKE_REMOTE_WRITES_PROBE=scripts/smoke/plane-split-worker.ts"
  exit 0
fi

exec corepack pnpm exec tsx scripts/smoke/plane-split-worker.ts
