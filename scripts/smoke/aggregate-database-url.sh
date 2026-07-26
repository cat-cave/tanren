#!/usr/bin/env bash
set -euo pipefail

# Resolve the owner connection used by the aggregate smoke wrapper. Keep this
# in one executable seam so every dependent recipe inherits the same mapped
# port instead of independently falling back to localhost:5432.
if [[ -n "${DATABASE_URL:-}" ]]; then
  printf '%s\n' "$DATABASE_URL"
  exit 0
fi

is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

offset="${TANREN_PORT_OFFSET:-0}"
port_override="${TANREN_POSTGRES_HOST_PORT:-}"
if ! is_uint "$offset"; then
  echo "aggregate smoke: TANREN_PORT_OFFSET must be a non-negative integer" >&2
  exit 2
fi

if [[ -n "$port_override" ]]; then
  if ! is_uint "$port_override" || (( port_override < 1 || port_override > 65535 )); then
    echo "aggregate smoke: TANREN_POSTGRES_HOST_PORT must be in 1..65535" >&2
    exit 2
  fi
  postgres_port="$port_override"
else
  postgres_port=$((5432 + offset))
  if (( postgres_port < 1 || postgres_port > 65535 )); then
    echo "aggregate smoke: derived Postgres port is outside 1..65535" >&2
    exit 2
  fi
fi

printf 'postgres://tanren:tanren@localhost:%s/tanren\n' "$postgres_port"
