#!/usr/bin/env bash
set -euo pipefail

# Resolve every database URL once for the nested de-privilege probe. This is a
# separate executable seam so an aggregate smoke's explicit URL and port offset
# cannot be lost when just invokes a child shell.
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

validate_port() {
  local name="$1" value="$2" normalized
  if ! is_uint "$value"; then
    echo "remote-writes smoke: ${name} must be a decimal port in 1..65535" >&2
    return 2
  fi
  normalized=$((10#$value))
  if (( normalized < 1 || normalized > 65535 )); then
    echo "remote-writes smoke: ${name} must be a decimal port in 1..65535" >&2
    return 2
  fi
}

validate_database_url() {
  local name="$1" value="$2"
  if ! node --input-type=module - "$value" >/dev/null 2>&1 <<'NODE'
// `node - <arg>` has used both argv[1] and argv[2] across supported launchers;
// the final argument is the only stable position after the stdin script marker.
const raw = process.argv.at(-1);
let parsed;
try { parsed = new URL(raw); } catch { process.exit(2); }
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') process.exit(2);
if (!parsed.port) process.exit(2);
const port = Number(parsed.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);
NODE
  then
    echo "remote-writes smoke: ${name} must be an explicit postgres URL with a valid host, database, and port" >&2
    return 2
  fi
}

redact_database_url() {
  node --input-type=module - "$1" <<'NODE'
const parsed = new URL(process.argv.at(-1));
process.stdout.write(`${parsed.protocol}//${parsed.hostname}:${parsed.port}${parsed.pathname}`);
NODE
}

resolve_config() {
  local offset_raw="${TANREN_PORT_OFFSET:-0}" offset postgres_port internal_port
  if ! is_uint "$offset_raw"; then
    echo "remote-writes smoke: TANREN_PORT_OFFSET must be a non-negative decimal integer" >&2
    return 2
  fi
  offset=$((10#$offset_raw))
  if (( offset > 60203 )); then
    echo "remote-writes smoke: TANREN_PORT_OFFSET produces an out-of-range default Postgres port" >&2
    return 2
  fi

  if [[ -n "${TANREN_POSTGRES_HOST_PORT:-}" ]]; then
    validate_port TANREN_POSTGRES_HOST_PORT "$TANREN_POSTGRES_HOST_PORT"
    postgres_port=$((10#$TANREN_POSTGRES_HOST_PORT))
  else
    postgres_port=$((5432 + offset))
  fi
  if [[ -n "${TANREN_INTERNAL_MTLS_HOST_PORT:-}" ]]; then
    validate_port TANREN_INTERNAL_MTLS_HOST_PORT "$TANREN_INTERNAL_MTLS_HOST_PORT"
    internal_port=$((10#$TANREN_INTERNAL_MTLS_HOST_PORT))
  else
    internal_port=$((3110 + offset))
  fi
  validate_port derived-postgres-port "$postgres_port"
  validate_port derived-internal-mtls-port "$internal_port"

  if [[ -n "${DATABASE_URL:-}" ]]; then validate_database_url DATABASE_URL "$DATABASE_URL"; fi
  if [[ -n "${TANREN_APP_DATABASE_URL:-}" ]]; then validate_database_url TANREN_APP_DATABASE_URL "$TANREN_APP_DATABASE_URL"; fi
  if [[ -n "${TANREN_DATAPLANE_DATABASE_URL:-}" ]]; then validate_database_url TANREN_DATAPLANE_DATABASE_URL "$TANREN_DATAPLANE_DATABASE_URL"; fi
}

resolve_config
if [[ "${1:-}" == "--validate" ]]; then
  exit 0
fi
if [[ "${1:-}" != "" ]]; then
  echo "remote-writes smoke: unknown argument '$1'" >&2
  exit 2
fi

offset=$((10#${TANREN_PORT_OFFSET:-0}))
if [[ -n "${TANREN_POSTGRES_HOST_PORT:-}" ]]; then
  postgres_port=$((10#$TANREN_POSTGRES_HOST_PORT))
else
  postgres_port=$((5432 + offset))
fi
if [[ -n "${TANREN_INTERNAL_MTLS_HOST_PORT:-}" ]]; then
  internal_port=$((10#$TANREN_INTERNAL_MTLS_HOST_PORT))
else
  internal_port=$((3110 + offset))
fi
export TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=1
export TANREN_CLAIM_ENDPOINT_SMOKE_URL="https://localhost:${internal_port}"
export TANREN_APP_DATABASE_URL="${TANREN_APP_DATABASE_URL:-postgres://tanren_app:tanren_app@localhost:${postgres_port}/tanren}"
export TANREN_DATAPLANE_DATABASE_URL="${TANREN_DATAPLANE_DATABASE_URL:-postgres://tanren_dataplane:tanren_dataplane@localhost:${postgres_port}/tanren}"
export DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:${postgres_port}/tanren}"
if [[ "${TANREN_SMOKE_REMOTE_WRITES_DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' \
    "TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=${TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE}" \
    "TANREN_CLAIM_ENDPOINT_SMOKE_URL=${TANREN_CLAIM_ENDPOINT_SMOKE_URL}" \
    "TANREN_APP_DATABASE_URL=$(redact_database_url "$TANREN_APP_DATABASE_URL")" \
    "TANREN_DATAPLANE_DATABASE_URL=$(redact_database_url "$TANREN_DATAPLANE_DATABASE_URL")" \
    "DATABASE_URL=$(redact_database_url "$DATABASE_URL")"
  exit 0
fi
exec corepack pnpm exec tsx scripts/smoke/plane-split-worker.ts
