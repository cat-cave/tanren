#!/usr/bin/env sh
set -eu

if [ -n "${TANREN_RUNNER_AUTHORIZED_KEY:-}" ]; then
  printf '%s\n' "$TANREN_RUNNER_AUTHORIZED_KEY" > /home/tanren/.ssh/authorized_keys
  chown tanren:tanren /home/tanren/.ssh/authorized_keys
  chmod 600 /home/tanren/.ssh/authorized_keys
fi

exec /usr/sbin/sshd -D -e
