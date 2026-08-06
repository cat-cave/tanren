# DEV-ONLY. The stock Vault image with the persistent-storage entrypoint baked in.
#
# The entrypoint is COPIED rather than bind-mounted from the host because the
# architecture gate forbids host bind mounts in a compose service (they are the
# workload-execution substrate this codebase routes through SSH instead), and
# inlining ~80 lines of shell into compose.dev.yml pushes that file past its
# 500-line cap. A three-line image keeps the script a reviewable standalone file.
FROM hashicorp/vault:1.18

COPY ops/vault/entrypoint.sh /usr/local/bin/tanren-vault-entrypoint.sh

# Runs as the unprivileged image user; the entrypoint sets `disable_mlock` (which
# is what dev mode already did), so no IPC_LOCK capability is needed.
USER vault

ENTRYPOINT ["/bin/sh", "/usr/local/bin/tanren-vault-entrypoint.sh"]
