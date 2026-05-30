#!/usr/bin/env bash
# Plane-split P2: generate the dev control↔data-plane mTLS material — a
# self-signed CA, a control-plane (server) cert, and a data-plane (worker/client)
# cert, all signed by the CA. Used ONLY for dev/smoke; prod supplies real certs
# via the same env (TANREN_INTERNAL_TLS_* on the control plane,
# TANREN_DATA_PLANE_TLS_* on the worker). Idempotent: skips if the CA exists.
#
# Output dir defaults to /tmp/tanren-mtls (bind-mounted into the orchestrator +
# worker containers by compose.dev.yml). NOT a PKI — one CA, two leaf certs.
set -euo pipefail

DIR="${TANREN_MTLS_DIR:-/tmp/tanren-mtls}"
mkdir -p "$DIR"

if [ -f "$DIR/ca.crt" ]; then
  echo "[gen-mtls-certs] $DIR/ca.crt already exists — reusing"
  exit 0
fi

echo "[gen-mtls-certs] generating dev mTLS CA + server + client certs in $DIR"

# CA
openssl genrsa -out "$DIR/ca.key" 2048 2>/dev/null
openssl req -x509 -new -nodes -key "$DIR/ca.key" -sha256 -days 3650 \
  -out "$DIR/ca.crt" -subj "/CN=tanren-internal-ca" 2>/dev/null

gen_leaf() {
  name="$1"; cn="$2"
  openssl genrsa -out "$DIR/$name.key" 2048 2>/dev/null
  openssl req -new -key "$DIR/$name.key" -out "$DIR/$name.csr" -subj "/CN=$cn" 2>/dev/null
  # SAN so TLS hostname verification accepts the compose service name + localhost.
  openssl x509 -req -in "$DIR/$name.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" \
    -CAcreateserial -out "$DIR/$name.crt" -days 3650 -sha256 \
    -extfile <(printf "subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1" "$3") 2>/dev/null
  rm -f "$DIR/$name.csr"
}

# Control plane (server) cert — CN/SAN = the orchestrator service name.
gen_leaf server orchestrator orchestrator
# Data plane (client) cert — the worker's service identity.
gen_leaf worker tanren-worker worker

chmod 644 "$DIR"/*.crt "$DIR"/*.key
echo "[gen-mtls-certs] done: ca.crt server.crt worker.crt (+ keys) in $DIR"
