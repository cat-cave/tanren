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

validate_port() {
  local name="$1" value="$2" normalized
  if ! printf '%s\n' "$value" | grep -Eq '^[0-9]+$'; then
    echo "${name} must be a decimal port in 1..65535" >&2
    return 2
  fi
  normalized=$((10#$value))
  if (( normalized < 1 || normalized > 65535 )); then
    echo "${name} must be a decimal port in 1..65535" >&2
    return 2
  fi
}

if [[ -n "${TANREN_INTERNAL_MTLS_HOST_PORT:-}" ]]; then
  internal_mtls_port="$TANREN_INTERNAL_MTLS_HOST_PORT"
  validate_port TANREN_INTERNAL_MTLS_HOST_PORT "$internal_mtls_port"
else
  internal_mtls_port=$((3110 + port_offset_num))
  validate_port "derived internal mTLS port" "$internal_mtls_port"
fi
printf -v internal_mtls_port '%d' "$((10#$internal_mtls_port))"

if [[ -n "${TANREN_POSTGRES_HOST_PORT:-}" ]]; then
  postgres_port="$TANREN_POSTGRES_HOST_PORT"
  validate_port TANREN_POSTGRES_HOST_PORT "$postgres_port"
else
  postgres_port=$((5432 + port_offset_num))
  validate_port "derived Postgres port" "$postgres_port"
fi
printf -v postgres_port '%d' "$((10#$postgres_port))"

export TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=1
export TANREN_CLAIM_ENDPOINT_SMOKE_URL="https://localhost:${internal_mtls_port}"
export TANREN_APP_DATABASE_URL="${TANREN_APP_DATABASE_URL:-postgres://tanren_app:tanren_app@localhost:${postgres_port}/tanren}"
export TANREN_DATAPLANE_DATABASE_URL="${TANREN_DATAPLANE_DATABASE_URL:-postgres://tanren_dataplane:tanren_dataplane@localhost:${postgres_port}/tanren}"
export DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:${postgres_port}/tanren}"

redact_database_url() {
  local redacted_url="$1"
  case "$redacted_url" in
    *://*@*)
      local scheme remainder before_query query_suffix authority userinfo_candidate
      scheme="${redacted_url%%://*}://"
      remainder="${redacted_url#*://}"
      before_query="${remainder%%[?#]*}"
      query_suffix="${remainder#"$before_query"}"
      authority="${before_query%%/*}"
      userinfo_candidate="${before_query%%@*}"
      if [[ "$authority" == *@* || ( "$before_query" == *@* && "$userinfo_candidate" == *:* ) ]]; then
        redacted_url="${scheme}REDACTED@${before_query##*@}${query_suffix}"
      fi
      ;;
  esac
  printf '%s' "$redacted_url"
}

if [ "${TANREN_SMOKE_REMOTE_WRITES_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' \
    "TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=${TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE}" \
    "TANREN_CLAIM_ENDPOINT_SMOKE_URL=${TANREN_CLAIM_ENDPOINT_SMOKE_URL}" \
    "TANREN_APP_DATABASE_URL=$(redact_database_url "$TANREN_APP_DATABASE_URL")" \
    "TANREN_DATAPLANE_DATABASE_URL=$(redact_database_url "$TANREN_DATAPLANE_DATABASE_URL")" \
    "DATABASE_URL=$(redact_database_url "$DATABASE_URL")" \
    "TANREN_SMOKE_REMOTE_WRITES_PROBE=scripts/smoke/plane-split-worker.ts"
  exit 0
fi

exec corepack pnpm exec tsx scripts/smoke/plane-split-worker.ts
