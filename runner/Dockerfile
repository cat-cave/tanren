FROM debian:trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    nodejs \
    npm \
    openssh-server \
    python3 \
    tini \
  && rm -rf /var/lib/apt/lists/*

# codexbar (live subscription-window state) and ccusage (token-consumption
# accounting) run runner-side over SSH against the per-run CODEX_HOME — the
# orchestrator engine never spawns host processes. Both are fast-moving betas,
# so their versions are build args: bumping is a one-line --build-arg change.
# Sources verified against upstream on 2026-05-27:
#   codexbar: https://github.com/steipete/CodexBar/releases/tag/v0.30.0
#   ccusage:  https://www.npmjs.com/package/ccusage
ARG CODEXBAR_VERSION=0.30.0
ARG CCUSAGE_VERSION=

RUN npm install -g @openai/codex@0.133.0 \
  && if [ -n "${CCUSAGE_VERSION}" ]; then npm install -g "ccusage@${CCUSAGE_VERSION}"; else npm install -g ccusage; fi \
  && npm cache clean --force

# Download the codexbar linux CLI for the build arch, verify its published
# .sha256, and install the binary to /usr/local/bin/codexbar. The release
# tarball ships the binary as CodexBarCLI with a `codexbar` symlink alongside.
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) CODEXBAR_ARCH="x86_64" ;; \
    arm64) CODEXBAR_ARCH="aarch64" ;; \
    *) echo "unsupported arch for codexbar: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  ASSET="CodexBarCLI-v${CODEXBAR_VERSION}-linux-${CODEXBAR_ARCH}.tar.gz"; \
  BASE="https://github.com/steipete/CodexBar/releases/download/v${CODEXBAR_VERSION}"; \
  cd /tmp; \
  # --retry: the GitHub-releases download flakes intermittently in CI
  # ("curl (56) Connection reset"), which fails `just smoke` on unrelated PRs.
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o "${ASSET}" "${BASE}/${ASSET}"; \
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o "${ASSET}.sha256" "${BASE}/${ASSET}.sha256"; \
  EXPECTED="$(awk '{print $1}' "${ASSET}.sha256")"; \
  ACTUAL="$(sha256sum "${ASSET}" | awk '{print $1}')"; \
  [ "${EXPECTED}" = "${ACTUAL}" ] || { echo "codexbar sha256 mismatch: expected ${EXPECTED} got ${ACTUAL}" >&2; exit 1; }; \
  mkdir -p /tmp/codexbar; \
  tar xzf "${ASSET}" -C /tmp/codexbar; \
  install -m 0755 /tmp/codexbar/CodexBarCLI /usr/local/bin/codexbar; \
  rm -rf /tmp/codexbar "/tmp/${ASSET}" "/tmp/${ASSET}.sha256"; \
  codexbar -V; \
  ccusage --version

RUN useradd --create-home --shell /bin/bash --uid 1000 tanren \
  && mkdir -p /run/sshd /workspace /home/tanren/.ssh /tanren-runtime /tanren-runtime/codex-home \
  && chown -R tanren:tanren /workspace /home/tanren/.ssh /tanren-runtime \
  && chmod 700 /home/tanren/.ssh /tanren-runtime

RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
  && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config

COPY runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
