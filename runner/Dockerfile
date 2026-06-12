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

# corepack-based package-manager bootstrap for the NON-ROOT ssh user `tanren`.
#
# Tanren is stack-agnostic: a ts/pnpm project's `just bootstrap` runs the standard
# `corepack enable pnpm && pnpm install --frozen-lockfile`. That must work over SSH
# as the non-root `tanren` user. Without this block it fails three ways (all
# confirmed against the live runner):
#   1. EACCES — `corepack enable` symlinks shims into root-owned /usr/bin, which
#      `tanren` can't write. Running `corepack enable` HERE as root creates those
#      shims once (root-owned), so the runtime `corepack enable` by `tanren` is an
#      idempotent no-op success instead of a permission-denied failure.
#   2. broken pnpm — corepack defaults to "latest", which auto-fetches pnpm 11.x;
#      that build throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING on this node. We
#      pin a known-good pnpm 10.x via `corepack prepare ... --activate` and set
#      COREPACK_DEFAULT_TO_LATEST=0 so corepack NEVER silently upgrades to it.
#   3. ambiguity — a second `npm install -g pnpm@10` would shadow the corepack
#      shim; removed above so corepack is the single pnpm source.
# COREPACK_HOME is a shared world-readable dir so the prepared pnpm is usable by
# `tanren` at runtime (corepack's per-user default ~/.cache would not be primed).
# The pin matches the previously-working pre-installed pnpm; bumping is one line.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_DEFAULT_TO_LATEST=0
ARG PNPM_VERSION=10.34.3
RUN set -eu; \
  mkdir -p "${COREPACK_HOME}"; \
  corepack enable; \
  corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
  chmod -R a+rX "${COREPACK_HOME}"; \
  # sanity: the prepared pnpm runs as-is at build time
  pnpm --version

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

# sem — the entity-level diff tool (tree-sitter entity extraction: every
# function/class/method/type as a graph node with structural-hash identity, 26+
# languages). An OPTIONAL ACCELERATOR for Tanren's answerer lanes: the read-only
# Checker/Auditor + issue-triage agents shell `sem` over SSH in their sandbox to
# reason at the ENTITY level (which functions/types changed, cosmetic-vs-structural,
# blast radius) instead of raw lines — see docs/roadmap/entity-analysis-layer.md.
# It is NOT hard-required: an agent gracefully falls back to the raw `git diff` when
# sem cannot parse a stack (stack-flexible — Tanren bakes in no language assumption).
# `cargo install` FAILS here on an OpenSSL native-dep, so we download the prebuilt
# release binary and verify it against the release's combined `checksums.txt` (one
# `<sha>  <asset>` line per asset). Pinned + arch-mapped; bumping is a one-line
# --build-arg change. Source verified against upstream on 2026-06-10:
#   https://github.com/Ataraxy-Labs/sem/releases/tag/v0.9.0
ARG SEM_VERSION=0.9.0
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) SEM_ARCH="linux-x86_64" ;; \
    arm64) SEM_ARCH="linux-arm64" ;; \
    *) echo "unsupported arch for sem: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  ASSET="sem-${SEM_ARCH}.tar.gz"; \
  BASE="https://github.com/Ataraxy-Labs/sem/releases/download/v${SEM_VERSION}"; \
  cd /tmp; \
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o "${ASSET}" "${BASE}/${ASSET}"; \
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o checksums.txt "${BASE}/checksums.txt"; \
  EXPECTED="$(awk -v a="${ASSET}" '$2 == a {print $1}' checksums.txt)"; \
  [ -n "${EXPECTED}" ] || { echo "sem: no checksum for ${ASSET} in checksums.txt" >&2; exit 1; }; \
  ACTUAL="$(sha256sum "${ASSET}" | awk '{print $1}')"; \
  [ "${EXPECTED}" = "${ACTUAL}" ] || { echo "sem sha256 mismatch: expected ${EXPECTED} got ${ACTUAL}" >&2; exit 1; }; \
  mkdir -p /tmp/sem; \
  tar xzf "${ASSET}" -C /tmp/sem; \
  install -m 0755 /tmp/sem/sem /usr/local/bin/sem; \
  rm -rf /tmp/sem "/tmp/${ASSET}" /tmp/checksums.txt; \
  sem --version

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
