#!/usr/bin/env bash
# Host-side sanity-check for the usage tools (codexbar + ccusage). Lets an
# operator verify the two tools against a real CODEX_HOME without a full run.
#
# This is a HOST script and lives under scripts/, which is exempt from the
# no-host-process-spawn architecture rule (the rule only constrains the
# orchestrator engine). In a real run these same tools execute RUNNER-SIDE
# over SSH against the per-run materialized CODEX_HOME — never on the host.
#
# Usage: scripts/usage/print-usage.sh [provider] [cli] [codex_home]
#   provider   codexbar provider/window source (default: codex)
#   cli        ccusage CLI to account (default: codex)
#   codex_home CODEX_HOME to read from (default: ~/.codex)
set -euo pipefail

provider="${1:-codex}"
cli="${2:-codex}"
codex_home="${3:-${CODEX_HOME:-$HOME/.codex}}"

export CODEX_HOME="$codex_home"

echo "== usage summary =="
echo "CODEX_HOME : $CODEX_HOME"
echo "provider   : $provider"
echo "cli        : $cli"
echo

echo "-- codexbar (live subscription windows) --"
if command -v codexbar >/dev/null 2>&1; then
  codexbar usage --provider "$provider" --source cli --format json || echo "(codexbar reported no data)"
else
  echo "(codexbar not installed on host; it ships in the runner image)"
fi
echo

echo "-- ccusage (token-consumption accounting) --"
if command -v ccusage >/dev/null 2>&1; then
  ccusage "$cli" --json || echo "(ccusage reported no data)"
else
  echo "(ccusage not installed on host; it ships in the runner image)"
fi
