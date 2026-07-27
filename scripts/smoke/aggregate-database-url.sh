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

normalize_bounded_uint() {
  local value="$1" max="$2"
  is_uint "$value" || return 1
  while [[ ${#value} -gt 1 && ${value:0:1} == 0 ]]; do
    value="${value:1}"
  done
  [[ ${#value} -lt ${#max} || ( ${#value} -eq ${#max} && "$value" < "$max" || "$value" == "$max" ) ]] || return 1
  printf '%s' "$value"
}

offset="${TANREN_PORT_OFFSET:-0}"
port_override="${TANREN_POSTGRES_HOST_PORT:-}"
if ! is_uint "$offset"; then
  echo "aggregate smoke: TANREN_PORT_OFFSET must be a non-negative integer" >&2
  exit 2
fi
if ! offset_value="$(normalize_bounded_uint "$offset" 60103)"; then
  echo "aggregate smoke: TANREN_PORT_OFFSET must be in 0..60103" >&2
  exit 2
fi

if [[ -n "$port_override" ]]; then
  if ! port_override_value="$(normalize_bounded_uint "$port_override" 65535)" || (( port_override_value < 1 )); then
    echo "aggregate smoke: TANREN_POSTGRES_HOST_PORT must be in 1..65535" >&2
    exit 2
  fi
  postgres_port="$port_override_value"
else
  postgres_port=$((5432 + offset_value))
  if (( postgres_port < 1 || postgres_port > 65535 )); then
    echo "aggregate smoke: derived Postgres port is outside 1..65535" >&2
    exit 2
  fi
fi

printf 'postgres://tanren:tanren@localhost:%s/tanren\n' "$postgres_port"
