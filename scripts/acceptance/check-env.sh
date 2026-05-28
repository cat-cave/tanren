#!/usr/bin/env bash
# P2A-0015: validate the acceptance-gate environment up front. Failing here
# stops `just acceptance-*` before any orchestrator state mutates, so the
# operator gets a single clear error instead of a deep stack trace from the
# TypeScript runner.
#
# Required environment variables mirror the Phase 1 live proof pattern
# documented in docs/operator-guide/README.md and docs/operator-guide/acceptance.md.

set -euo pipefail

required=(
  "TANREN_CODEX_AUTH_JSON_FILE"
  "TANREN_GITHUB_TOKEN_FILE"
  "TANREN_GITHUB_REPO_URL"
  "TANREN_DATABASE_URL"
  "TANREN_VAULT_TOKEN"
)

missing=()
for var in "${required[@]}"; do
  value="${!var-}"
  if [ -z "${value}" ]; then
    missing+=("${var}")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "tanren acceptance: required environment variables are missing:" >&2
  for var in "${missing[@]}"; do
    echo "  - ${var}" >&2
  done
  echo "" >&2
  echo "See docs/operator-guide/acceptance.md for the full env-var contract." >&2
  exit 2
fi

# File existence is a fast-fail too — a missing credential bundle would
# surface as an opaque vault error mid-run otherwise.
for file_var in "TANREN_CODEX_AUTH_JSON_FILE" "TANREN_GITHUB_TOKEN_FILE"; do
  path="${!file_var}"
  if [ ! -f "${path}" ]; then
    echo "tanren acceptance: ${file_var}=${path} does not exist or is not a regular file" >&2
    exit 2
  fi
done

echo "tanren acceptance: env validated (db=${TANREN_DATABASE_URL%%@*}@…, repo=${TANREN_GITHUB_REPO_URL})"
