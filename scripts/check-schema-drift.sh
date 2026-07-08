#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR"
cp -R "$ROOT_DIR/db/migrations" "$TMP_DIR/migrations"
# Compute the migrations dir relative to ROOT_DIR. GNU realpath (Linux/CI) has
# --relative-to; BSD/macOS realpath does not, so fall back to python3 there.
if realpath --relative-to=/ / >/dev/null 2>&1; then
  OUT_DIR="$(realpath --relative-to="$ROOT_DIR" "$TMP_DIR/migrations")"
else
  OUT_DIR="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$TMP_DIR/migrations" "$ROOT_DIR")"
fi

cat > "$TMP_DIR/drizzle.config.ts" <<EOF
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "$ROOT_DIR/db/src/schema.ts",
  out: "$OUT_DIR",
  dialect: "postgresql"
});
EOF

cd "$ROOT_DIR"
if ! OUTPUT="$(corepack pnpm exec drizzle-kit generate --config "$TMP_DIR/drizzle.config.ts" --name schema_drift_check --prefix none 2>&1)"; then
  printf '%s\n' "$OUTPUT"
  exit 1
fi
printf '%s\n' "$OUTPUT"

if grep -q "Error:" <<<"$OUTPUT"; then
  exit 1
fi

if ! diff -ru "$ROOT_DIR/db/migrations" "$TMP_DIR/migrations"; then
  echo "schema drift detected: run 'corepack pnpm run db:generate' and commit the generated migrations" >&2
  exit 1
fi
