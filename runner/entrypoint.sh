#!/usr/bin/env sh
set -eu

# Per-run runner containers are ephemeral. Allocator creates a new container
# on /allocate and destroys it on /release (wiping /workspace and
# /tanren-runtime). Each start regenerates SSH host keys so the runner image
# never carries keys across runs.
rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
ssh-keygen -A

# Validate the per-run scratch mount is empty. The allocator wipes the
# /workspace volume on /release; if a stale file survives the container has
# leaked between runs and we must fail loudly rather than reuse it. The check
# only fires when the allocator marks this as a per-run ephemeral container
# (TANREN_RUNNER_EPHEMERAL=1); the dev compose static runner skips it for
# backward compatibility with smoke tests.
if [ "${TANREN_RUNNER_EPHEMERAL:-0}" = "1" ]; then
  if [ -n "$(ls -A /workspace 2>/dev/null)" ]; then
    echo "FATAL: /workspace is not empty on startup; allocator finalizer leaked state" >&2
    exit 1
  fi
  if [ -d /tanren-runtime ] && [ -n "$(ls -A /tanren-runtime 2>/dev/null | grep -v '^codex-home$' || true)" ]; then
    echo "FATAL: /tanren-runtime contains unexpected entries on startup" >&2
    exit 1
  fi
fi

# CODEX_HOME is an empty per-run directory at /tanren-runtime/codex-home, made
# visible to interactive ssh sessions. NO secret is delivered to the runner via
# Docker env: run-scoped credentials (the tenant's model/codex auth.json) are
# written here over the SSH FILE substrate by the orchestrator AFTER allocation
# (codexMaterializer / opencodeMaterializer). The runner therefore starts with an
# empty CODEX_HOME and `docker inspect` carries no secret value.
mkdir -p /tanren-runtime/codex-home
chown -R tanren:tanren /tanren-runtime/codex-home
chmod 700 /tanren-runtime/codex-home
echo "export CODEX_HOME=/tanren-runtime/codex-home" > /etc/profile.d/codex-home.sh
chmod 644 /etc/profile.d/codex-home.sh

if [ -n "${TANREN_RUNNER_AUTHORIZED_KEY:-}" ]; then
  printf '%s\n' "$TANREN_RUNNER_AUTHORIZED_KEY" > /home/tanren/.ssh/authorized_keys
  chown tanren:tanren /home/tanren/.ssh/authorized_keys
  chmod 600 /home/tanren/.ssh/authorized_keys
fi

exec /usr/sbin/sshd -D -e
