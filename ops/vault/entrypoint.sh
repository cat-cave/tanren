#!/bin/sh
#
# DEV-ONLY Vault entrypoint giving the local stack a PERSISTENT storage backend.
#
# `compose.dev.yml` ran `vault server -dev`, which is IN-MEMORY: a container or
# Docker VM restart erased every credential (GitHub App key, LLM router key,
# proof-signing key, per-org BYOK) and re-seeding needs material only a human
# holds. For a stack built for multi-hour autonomous drives that is data loss.

set -eu

# Not production hardening: the smallest change that stops the loss. The token
# contract (`dev-root-token`) and the kv-v2 mount at `secret/` are unchanged —
# dev mode used to provide both, so this provides them instead. Vault is
# auto-unsealed from a key kept beside its own data, which is a deliberate
# dev-only trade for unattended boot and is NOT safe for production;
# `compose.prod.yml` needs a real init/unseal, not a copy of this file.

: "${VAULT_ADDR:=http://127.0.0.1:8200}"
export VAULT_ADDR

ROOT_TOKEN_ID="${TANREN_VAULT_ROOT_TOKEN_ID:-dev-root-token}"
DATA_DIR=/vault/file
UNSEAL_KEY_FILE="$DATA_DIR/tanren-dev-unseal-key"
CONFIG_FILE=/tmp/tanren-vault.hcl

log() { printf 'vault-dev: %s\n' "$*"; }
die() { printf 'vault-dev: %s\n' "$*" >&2; exit 1; }

# `disable_mlock` is what dev mode already did, so this is no posture regression;
# it also lets the server run as the unprivileged `vault` user.
cat >"$CONFIG_FILE" <<EOF
storage "file" {
  path = "$DATA_DIR"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr      = "$VAULT_ADDR"
disable_mlock = true
ui            = false
EOF

log "starting server with file storage at $DATA_DIR (persistent across restarts)"
vault server -config="$CONFIG_FILE" &
server_pid=$!

# Forward termination and then WAIT — a risk that only exists now that there IS
# durable state, and forwarding alone does not cover it.
#
# Under `set -e` the bare forward was worse than nothing. A trapped signal
# interrupts the final `wait`, which returns 143, and `set -e` exits the script on
# it — so PID 1 was gone while Vault was still flushing its file backend, and Docker
# then killed the container out from under the write. The whole point of this file
# is that the store survives; tearing it mid-write is the one way to lose it that
# `server -dev` could not.
#
# The handler ignores REPEATED signals (an impatient `docker compose stop` sends
# more) so the drain cannot itself be interrupted, and the wait below re-waits until
# the server has actually reaped.
shutdown() {
  trap "" TERM INT
  log "termination requested - waiting for Vault to flush its file storage"
  kill -TERM "$server_pid" 2>/dev/null || true
}
trap shutdown TERM INT

# `vault status` exits 0 unsealed, 2 sealed, other while the listener is coming up.
attempt=0
while :; do
  rc=0
  vault status >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 150 ]; then
    die "server did not become reachable at $VAULT_ADDR after 60s"
  fi
  sleep 0.4
done

status_field() {
  vault status 2>/dev/null | awk -v key="$1" '$1 == key { print $2 }'
}

wipe_hint="Remove the vaultdata volume to start clean (this DESTROYS every stored credential)."

if [ "$(status_field Initialized)" = "true" ]; then
  log "existing Vault store found - reusing it (credentials survive)"
  if [ "$(status_field Sealed)" = "true" ]; then
    [ -f "$UNSEAL_KEY_FILE" ] ||
      die "store at $DATA_DIR is initialized but its unseal key file is missing; it cannot be unsealed. $wipe_hint"
    vault operator unseal "$(cat "$UNSEAL_KEY_FILE")" >/dev/null ||
      die "unseal failed with the stored key - the volume is inconsistent. $wipe_hint"
    log "unsealed"
  fi
  VAULT_TOKEN="$ROOT_TOKEN_ID"
  export VAULT_TOKEN
  vault token lookup >/dev/null 2>&1 ||
    die "the stored Vault does not accept '$ROOT_TOKEN_ID'; it was initialized by another configuration. $wipe_hint"
else
  log "no existing store - initializing a fresh one"
  # One key share: a dev stack must come up unattended.
  init_output="$(vault operator init -key-shares=1 -key-threshold=1)" || die "vault operator init failed"
  unseal_key="$(printf '%s\n' "$init_output" | awk '/^Unseal Key 1:/ { print $4 }')"
  initial_root="$(printf '%s\n' "$init_output" | awk '/^Initial Root Token:/ { print $4 }')"
  [ -n "$unseal_key" ] || die "could not parse an unseal key out of the init output"
  [ -n "$initial_root" ] || die "could not parse the initial root token out of the init output"

  (
    umask 077
    printf '%s\n' "$unseal_key" >"$UNSEAL_KEY_FILE"
  )

  vault operator unseal "$unseal_key" >/dev/null || die "initial unseal failed"
  log "initialized and unsealed"

  VAULT_TOKEN="$initial_root"
  export VAULT_TOKEN
  # `-orphan` so the stack's token does not die with the init token's lease tree;
  # no TTL, so it behaves exactly like the dev-mode token it replaces.
  vault token create -id="$ROOT_TOKEN_ID" -policy=root -orphan -display-name=tanren-dev >/dev/null ||
    die "could not create the fixed dev token"
  log "created the fixed dev token"
  # The init root token is never written to disk and the stack never uses it.
  vault token revoke -self >/dev/null 2>&1 || true
  VAULT_TOKEN="$ROOT_TOKEN_ID"
  export VAULT_TOKEN
fi

# kv-v2 at `secret/` was auto-mounted by dev mode; mount it so the SecretStore's
# default mount keeps working unchanged.
if vault secrets list 2>/dev/null | grep -q '^secret/'; then
  log "kv-v2 already mounted at secret/"
else
  vault secrets enable -path=secret -version=2 kv >/dev/null || die "could not enable kv-v2 at secret/"
  log "enabled kv-v2 at secret/"
fi

unset VAULT_TOKEN
log "ready - storage is persistent, credentials survive a container restart"

# `wait` returns >128 when a trapped signal interrupted it rather than when the child
# actually exited, and the child may still be draining. Keep waiting until it is
# really gone, then exit with ITS status so a crash is still reported as a crash.
rc=0
while :; do
  # Reset per attempt: `|| rc=$?` only assigns on failure, so a successful re-wait
  # after an interrupted one would otherwise leave the stale 143 as our exit status.
  rc=0
  wait "$server_pid" || rc=$?
  if [ "$rc" -gt 128 ] && kill -0 "$server_pid" 2>/dev/null; then
    continue
  fi
  break
done
log "vault exited with status $rc"
exit "$rc"
