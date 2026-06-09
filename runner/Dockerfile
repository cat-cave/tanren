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
  && npm install -g pnpm@10 \
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

# jujutsu (jj) — the SOLE `WorkspaceVcsCore` backend (tanren-owns-the-engine.md §2;
# there is no git fallback). The runner shells `jj` over SSH exactly like `git`; jj
# keeps a real git backend so the host stays a plain git remote. Pinned + arch-mapped
# against the published release. The pin MUST match .github/workflows/ci.yml (the
# WorkspaceVcsCore conformance drives a real jj). Bumping is a one-line --build-arg
# change. Source verified against upstream on 2026-06-07:
#   https://github.com/jj-vcs/jj/releases/tag/v0.42.0
ARG JJ_VERSION=0.42.0
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) JJ_ARCH="x86_64" ;; \
    arm64) JJ_ARCH="aarch64" ;; \
    *) echo "unsupported arch for jj: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  ASSET="jj-v${JJ_VERSION}-${JJ_ARCH}-unknown-linux-musl.tar.gz"; \
  BASE="https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}"; \
  cd /tmp; \
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o "${ASSET}" "${BASE}/${ASSET}"; \
  tar xzf "${ASSET}"; \
  install -m 0755 jj /usr/local/bin/jj; \
  rm -rf "/tmp/${ASSET}" /tmp/jj; \
  jj --version

# just — the stack-agnostic lifecycle command runner. Tanren assumes NO tech stack:
# a project declares its lifecycle in a `justfile` (bootstrap / tier-1..3 / build /
# deploy), and the native gate's `.tanren/ci.yml` steps defer to `just <target>`. The
# runner shells `just` over SSH exactly like `git`/`jj`, so it MUST be on the image.
# Pinned + arch-mapped against the published release; bumping is a one-line --build-arg
# change. Source verified against upstream on 2026-06-08:
#   https://github.com/casey/just/releases/tag/1.52.0
ARG JUST_VERSION=1.52.0
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) JUST_ARCH="x86_64" ;; \
    arm64) JUST_ARCH="aarch64" ;; \
    *) echo "unsupported arch for just: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  ASSET="just-${JUST_VERSION}-${JUST_ARCH}-unknown-linux-musl.tar.gz"; \
  BASE="https://github.com/casey/just/releases/download/${JUST_VERSION}"; \
  cd /tmp; \
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o "${ASSET}" "${BASE}/${ASSET}"; \
  mkdir -p /tmp/just; \
  tar xzf "${ASSET}" -C /tmp/just; \
  install -m 0755 /tmp/just/just /usr/local/bin/just; \
  rm -rf /tmp/just "/tmp/${ASSET}"; \
  just --version

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
