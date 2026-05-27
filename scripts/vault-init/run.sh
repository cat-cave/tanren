#!/usr/bin/env bash
#
# Tanren Vault init script. Idempotent.
#
# Once per fresh Vault (or when secrets rotate), this script:
#   1. Verifies the Vault is reachable and authenticated.
#   2. Enables the kv-v2 secrets engine at `secret/` if not already enabled.
#   3. Enables the AppRole auth method if not already enabled.
#   4. Creates per-service AppRoles (`orchestrator`, `allocator`) idempotently.
#   5. Writes the org-level GitHub OAuth client secret at the path
#      `org/github/oauth/default` (the orchestrator P2A-0003 doc names this
#      shape; v0 uses a `default` org slug, per-org overrides ship in later
#      Phase 2A specs).
#
# Required env:
#   VAULT_ADDR                          Vault address. Defaults below per profile.
#   VAULT_ROOT_TOKEN                    Vault root token (prod) or the dev token (dev).
#   TANREN_GITHUB_OAUTH_CLIENT_ID       GitHub OAuth client id.
#   TANREN_GITHUB_OAUTH_CLIENT_SECRET   GitHub OAuth client secret.
#
# Usage:
#   ./scripts/vault-init/run.sh prod
#   ./scripts/vault-init/run.sh dev
#
# Dev mode is provided so the same code path is exercised locally; CI does
# not run it.

set -euo pipefail

profile="${1:-prod}"

case "${profile}" in
  prod)
    : "${VAULT_ADDR:=http://127.0.0.1:8200}"
    : "${VAULT_ROOT_TOKEN:?VAULT_ROOT_TOKEN must be set}"
    : "${TANREN_GITHUB_OAUTH_CLIENT_ID:?TANREN_GITHUB_OAUTH_CLIENT_ID must be set}"
    : "${TANREN_GITHUB_OAUTH_CLIENT_SECRET:?TANREN_GITHUB_OAUTH_CLIENT_SECRET must be set}"
    ;;
  dev)
    : "${VAULT_ADDR:=http://127.0.0.1:18200}"
    : "${VAULT_ROOT_TOKEN:=dev-root-token}"
    : "${TANREN_GITHUB_OAUTH_CLIENT_ID:=dev-client-id}"
    : "${TANREN_GITHUB_OAUTH_CLIENT_SECRET:=dev-client-secret}"
    ;;
  *)
    echo "vault-init: unknown profile '${profile}'. Expected 'prod' or 'dev'." >&2
    exit 2
    ;;
esac

VAULT_TOKEN_HEADER="X-Vault-Token: ${VAULT_ROOT_TOKEN}"

vault_curl() {
  local method="$1"
  local path="$2"
  shift 2
  curl --fail-with-body --silent --show-error \
    --request "${method}" \
    --header "${VAULT_TOKEN_HEADER}" \
    --header "Content-Type: application/json" \
    "$@" \
    "${VAULT_ADDR}${path}"
}

vault_get_or_404() {
  local path="$1"
  local status
  status=$(curl --silent --output /dev/null --write-out "%{http_code}" \
    --header "${VAULT_TOKEN_HEADER}" \
    "${VAULT_ADDR}${path}")
  echo "${status}"
}

echo "vault-init: addr=${VAULT_ADDR} profile=${profile}"

# 1. Health check.
health_status=$(curl --silent --output /dev/null --write-out "%{http_code}" \
  "${VAULT_ADDR}/v1/sys/health" || true)
case "${health_status}" in
  200|429|472|473)
    echo "vault-init: vault reachable (status=${health_status})"
    ;;
  *)
    echo "vault-init: vault unreachable at ${VAULT_ADDR} (status=${health_status})" >&2
    exit 1
    ;;
esac

# 2. Ensure kv-v2 at `secret/`.
mounts_status=$(vault_get_or_404 "/v1/sys/mounts")
if [ "${mounts_status}" != "200" ]; then
  echo "vault-init: cannot list mounts (status=${mounts_status})" >&2
  exit 1
fi
mounts=$(curl --silent --header "${VAULT_TOKEN_HEADER}" "${VAULT_ADDR}/v1/sys/mounts")
if ! printf '%s' "${mounts}" | grep -q '"secret/"'; then
  echo "vault-init: enabling kv-v2 at secret/"
  vault_curl POST "/v1/sys/mounts/secret" --data '{"type":"kv","options":{"version":"2"}}' >/dev/null
else
  echo "vault-init: kv-v2 at secret/ already enabled"
fi

# 3. Ensure AppRole auth method.
auth_methods=$(curl --silent --header "${VAULT_TOKEN_HEADER}" "${VAULT_ADDR}/v1/sys/auth")
if ! printf '%s' "${auth_methods}" | grep -q '"approle/"'; then
  echo "vault-init: enabling approle auth"
  vault_curl POST "/v1/sys/auth/approle" --data '{"type":"approle"}' >/dev/null
else
  echo "vault-init: approle auth already enabled"
fi

# 4. Create per-service AppRoles. Idempotent: POST to /role/<name> upserts.
for role in orchestrator allocator; do
  echo "vault-init: upserting approle ${role}"
  vault_curl POST "/v1/auth/approle/role/${role}" \
    --data '{"token_policies":["default"],"token_ttl":"1h","token_max_ttl":"24h"}' >/dev/null
done

# 5. Write GitHub OAuth client secret.
oauth_path="/v1/secret/data/org/github/oauth/default"
echo "vault-init: writing org/github/oauth/default"
payload=$(printf '{"data":{"client_id":"%s","client_secret":"%s"}}' \
  "${TANREN_GITHUB_OAUTH_CLIENT_ID}" \
  "${TANREN_GITHUB_OAUTH_CLIENT_SECRET}")
vault_curl POST "${oauth_path}" --data "${payload}" >/dev/null

echo "vault-init: done"
