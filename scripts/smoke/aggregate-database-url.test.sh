#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/aggregate-database-url.sh"

actual="$(TANREN_PORT_OFFSET=1965 DATABASE_URL= "$script")"
test "$actual" = "postgres://tanren:tanren@localhost:7397/tanren"

actual="$(TANREN_PORT_OFFSET=08 DATABASE_URL= "$script")"
test "$actual" = "postgres://tanren:tanren@localhost:5440/tanren"

actual="$(TANREN_PORT_OFFSET=100 TANREN_POSTGRES_HOST_PORT=00009 DATABASE_URL= "$script")"
test "$actual" = "postgres://tanren:tanren@localhost:9/tanren"

explicit='postgres://custom:secret@example.invalid:6543/tenant'
actual="$(DATABASE_URL="$explicit" TANREN_PORT_OFFSET=1965 "$script")"
test "$actual" = "$explicit"

if TANREN_PORT_OFFSET=-1 DATABASE_URL= "$script" >/dev/null 2>&1; then
  echo "negative control failed: negative offset was accepted" >&2
  exit 1
fi

if TANREN_PORT_OFFSET=18446744073709551615 DATABASE_URL= "$script" >/dev/null 2>&1; then
  echo "negative control failed: overflowing offset was accepted" >&2
  exit 1
fi

if TANREN_POSTGRES_HOST_PORT=70000 DATABASE_URL= "$script" >/dev/null 2>&1; then
  echo "negative control failed: out-of-range port was accepted" >&2
  exit 1
fi

echo "aggregate database URL checks passed"
