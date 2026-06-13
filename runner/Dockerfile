FROM debian:trixie-slim

# Neutral sandbox base — a C toolchain to COMPILE things (build-essential),
# git/ssh/network, python3 (interpreter for tooling, NOT a project stack pin),
# tini, and the decompressors the pinned-binary installs below need (xz-utils
# for the official node tarball). Deliberately NO project toolchain: no apt
# `nodejs`/`npm`/`pnpm`. The project provisions its own node/python/rust/etc at
# its declared versions at runtime via `mise` (installed below) in user space —
# Tanren core hardcodes ZERO project toolchain (environment-management.md §2).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    openssh-server \
    python3 \
    tini \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Harness node — Tanren's OWN infrastructure node, NOT the project's stack. The
# harness CLIs below (codex/codexbar/ccusage) are node programs Tanren ships; they
# need a node that is stable and independent of whatever toolchain a project later
# provisions via `mise`. This is installed to /usr/local (on the system PATH ahead
# of any per-project mise shims, which are never globally activated — see below),
# so a bare non-`tanren`-mise shell always resolves THIS node. The apt `nodejs` is
# the stale v20; we pin the current node 24 LTS (Krypton) from the official dist
# and verify it against the release SHASUMS256. This is a HARNESS dependency (a
# Tanren-owned version), which the doctrine explicitly permits — it is not a
# project version. Bumping is a one-line --build-arg change. Source verified
# against upstream on 2026-06-12:
#   https://nodejs.org/dist/v24.16.0/ (current LTS)
ARG NODE_VERSION=24.16.0
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) NODE_ARCH="x64" ;; \
    arm64) NODE_ARCH="arm64" ;; \
    *) echo "unsupported arch for node: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  ASSET="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
  BASE="https://nodejs.org/dist/v${NODE_VERSION}"; \
  cd /tmp; \
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o "${ASSET}" "${BASE}/${ASSET}"; \
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o SHASUMS256.txt "${BASE}/SHASUMS256.txt"; \
  EXPECTED="$(awk -v a="${ASSET}" '$2 == a {print $1}' SHASUMS256.txt)"; \
  [ -n "${EXPECTED}" ] || { echo "node: no checksum for ${ASSET} in SHASUMS256.txt" >&2; exit 1; }; \
  ACTUAL="$(sha256sum "${ASSET}" | awk '{print $1}')"; \
  [ "${EXPECTED}" = "${ACTUAL}" ] || { echo "node sha256 mismatch: expected ${EXPECTED} got ${ACTUAL}" >&2; exit 1; }; \
  tar xJf "${ASSET}" -C /usr/local --strip-components=1 \
    --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'; \
  rm -rf "/tmp/${ASSET}" /tmp/SHASUMS256.txt; \
  node --version; \
  npm --version

# codexbar (live subscription-window state) and ccusage (token-consumption
# accounting) run runner-side over SSH against the per-run CODEX_HOME — the
# orchestrator engine never spawns host processes. Both are fast-moving betas,
# so their versions are build args: bumping is a one-line --build-arg change.
# These are HARNESS CLIs (Tanren infrastructure), installed globally against the
# harness node above — they are NOT a project toolchain. NOTE: there is no
# `pnpm` here on purpose: pnpm is a PROJECT tool, which the project provisions
# per-project via `mise` (the runner bakes no project stack).
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

# mise (jdx/mise) — the single GENERAL, per-project toolchain provisioner. This
# is what replaces the old baked `pnpm@10` + corepack: the runner ships NO project
# toolchain, and instead a project declares its tools/versions (`mise.toml` +
# `mise.lock`: node/python/rust/pnpm/… at the PROJECT's chosen versions) and the
# project's lifecycle commands provision them at runtime in user space via
# `mise install` (environment-management.md §2/§3). mise is rootless — its data,
# install and cache dirs default under $HOME (~/.local/share/mise, ~/.cache/mise),
# which is writable for the non-root `tanren` user — so a project toolchain never
# needs to write root-owned paths (the corepack `/usr/bin` EACCES is gone).
#
# CRITICAL — harness/project isolation: mise is installed ONLY as a binary on the
# system PATH; it is NOT globally shell-activated for `tanren` (no `mise activate`
# in any login/profile script). A bare shell therefore sees the HARNESS node
# (/usr/local/bin, above) — codex/codexbar/ccusage keep working regardless of what
# node a project declares. A project's mise toolchain only shadows node WITHIN a
# command that explicitly opts in (`mise exec --` / `eval "$(mise activate bash)"`);
# that per-lifecycle wiring lands in a later PR. This PR only makes the runner
# CAPABLE. The binary is verified against the release's SHASUMS256.txt. Pinned +
# arch-mapped; bumping is a one-line --build-arg change. Source verified against
# upstream on 2026-06-12:
#   https://github.com/jdx/mise/releases/tag/v2026.6.4
ARG MISE_VERSION=2026.6.4
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) MISE_ARCH="x64" ;; \
    arm64) MISE_ARCH="arm64" ;; \
    *) echo "unsupported arch for mise: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  ASSET="mise-v${MISE_VERSION}-linux-${MISE_ARCH}-musl.tar.gz"; \
  BASE="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}"; \
  cd /tmp; \
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o "${ASSET}" "${BASE}/${ASSET}"; \
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 -o SHASUMS256.txt "${BASE}/SHASUMS256.txt"; \
  EXPECTED="$(awk -v a="${ASSET}" '{f=$2; sub(/^\.\//,"",f)} f == a {print $1}' SHASUMS256.txt)"; \
  [ -n "${EXPECTED}" ] || { echo "mise: no checksum for ${ASSET} in SHASUMS256.txt" >&2; exit 1; }; \
  ACTUAL="$(sha256sum "${ASSET}" | awk '{print $1}')"; \
  [ "${EXPECTED}" = "${ACTUAL}" ] || { echo "mise sha256 mismatch: expected ${EXPECTED} got ${ACTUAL}" >&2; exit 1; }; \
  mkdir -p /tmp/mise; \
  tar xzf "${ASSET}" -C /tmp/mise; \
  install -m 0755 /tmp/mise/mise/bin/mise /usr/local/bin/mise; \
  rm -rf /tmp/mise "/tmp/${ASSET}" /tmp/SHASUMS256.txt; \
  mise --version

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

# === WARM mise BASELINE — the GOLDEN IMAGE's speed mechanism (env-management.md
# §3 Layer 3 + §7 P2). The runner ships NO project toolchain BAKED ON PATH (the
# harness node at /usr/local stays the only PATH node — isolation invariant from
# P0a). Instead we pre-WARM a SHARED mise data dir with the empirically-common
# baseline (runner/mise.baseline.toml) so a project declaring that baseline gets a
# warm CACHE HIT at workspace-prep instead of a cold download.
#
# THE SHARED-DATA-DIR MECHANISM (how the warm cache stays usable by `tanren` AND
# isolated from the harness):
#   - /opt/tanren/mise is the shared mise DATA dir (installs/, shims/, lockfile),
#     /opt/tanren/mise-cache the CACHE dir. Both are OWNED BY `tanren` (uid 1000)
#     and world-readable. Ownership-by-tanren (not root-owned read-only) is
#     deliberate: it makes the dir the warm baseline AND writable for the DELTA —
#     a project declaring an OFF-baseline version cold-installs into the SAME dir
#     in user space (no EACCES), exactly the layering §3 Layer 3 describes.
#   - The `tanren` user defaults MISE_DATA_DIR/MISE_CACHE_DIR to these via
#     /etc/profile.d (login shells) AND ~/.config/mise/config.toml-adjacent env —
#     so an interactive SSH session + the gate's `mise install`/`mise activate`
#     (engine/ssh/miseActivate.ts) resolve the pre-warmed installs.
#   - mise is NEVER globally ACTIVATED (no `mise activate` in any profile that
#     mutates PATH unconditionally — see the mise install block above). A bare
#     shell therefore still resolves the /usr/local HARNESS node; codex/codexbar/
#     ccusage stay on the harness node regardless of the warm baseline. The warm
#     toolchains are only used when a command opts in (the project-command path's
#     `eval "$(mise activate bash)"`), never the harness/answerer path.
ENV TANREN_MISE_DATA_DIR=/opt/tanren/mise \
  TANREN_MISE_CACHE_DIR=/opt/tanren/mise-cache
COPY runner/mise.baseline.toml /opt/tanren/mise.baseline.toml
RUN set -eu; \
  mkdir -p "${TANREN_MISE_DATA_DIR}" "${TANREN_MISE_CACHE_DIR}" /home/tanren/.config/mise; \
  # Own the ENTIRE /home/tanren/.config tree as `tanren` — NOT just the mise dirs.
  # `mkdir -p .../.config/mise` (above) CREATES /home/tanren/.config as ROOT; left
  # root:root (mode 755) the non-root `tanren` user can READ but NOT create sibling
  # subdirs. jj then cannot create its per-repo secure-config state dir
  # (`~/.config/jj/repos/<hash>`) — "Failed to determine the secure config for a
  # repo: ... Permission denied (os error 13)" — which strands BOTH the per-spec
  # `jj git clone` AND the tier-3 native (jj) merge. Chowning the whole tree keeps
  # ~/.config writable for jj (and any other tool that uses it).
  chown -R tanren:tanren /opt/tanren "${TANREN_MISE_DATA_DIR}" "${TANREN_MISE_CACHE_DIR}" /home/tanren/.config; \
  # Persist the shared-dir env for `tanren` login shells (interactive SSH) so the
  # gate's mise commands resolve the SHARED data dir. profile.d is sourced by the
  # login shell sshd starts; we also write a non-login fallback via ~/.bashrc.
  printf 'export MISE_DATA_DIR=%s\nexport MISE_CACHE_DIR=%s\n' "${TANREN_MISE_DATA_DIR}" "${TANREN_MISE_CACHE_DIR}" \
    > /etc/profile.d/tanren-mise-shared-dir.sh; \
  chmod 644 /etc/profile.d/tanren-mise-shared-dir.sh; \
  printf '\n# Golden-image shared mise warm-baseline data dir (env-management.md P2).\nexport MISE_DATA_DIR=%s\nexport MISE_CACHE_DIR=%s\n' \
    "${TANREN_MISE_DATA_DIR}" "${TANREN_MISE_CACHE_DIR}" >> /home/tanren/.bashrc; \
  chown tanren:tanren /home/tanren/.bashrc; \
  # Pre-warm AS `tanren` (uid 1000) so every install dir is tanren-owned — the
  # same user the SSH gate runs as resolves them read-only on a hit and can write
  # the delta on a miss. `mise trust` clears the config-trust gate for the
  # Tanren-baked baseline config; `mise install` resolves each loose major to the
  # latest patch at BUILD time (freshness — never a stale exact pin) and downloads
  # it once into the shared dir.
  su -s /bin/sh tanren -c '\
    set -eu; \
    export MISE_DATA_DIR='"${TANREN_MISE_DATA_DIR}"' MISE_CACHE_DIR='"${TANREN_MISE_CACHE_DIR}"' MISE_YES=1; \
    export MISE_GLOBAL_CONFIG_FILE=/opt/tanren/mise.baseline.toml; \
    mise trust /opt/tanren/mise.baseline.toml; \
    mise install; \
    echo "=== golden-image warm baseline (resolved patches) ==="; \
    mise ls --installed; \
  '; \
  # World-readable so a warm hit is a pure read; tanren keeps write for the delta.
  chmod -R a+rX "${TANREN_MISE_DATA_DIR}"

# jj user-level identity DEFAULT for the `tanren` user. jj 0.42 commits with the
# EMPTY identity (and warns "Name and email not configured ... can't be pushed to
# remotes") until user.name/email are set. Tanren's run path sets a PER-REPO identity
# right after `jj git clone` (`jj config set --repo user.name/email` in
# JjWorkspaceVcsCore.openWorkspace — a bot login on the live merge/conflict-resolve
# path, else a non-attributable default), and a `--repo` value OVERRIDES this
# `--user` default, so the per-run identity is unchanged. This baked default is a
# belt-and-suspenders: it gives `tanren` a usable author during the clone window
# (silencing the empty-identity warning) and for any ad-hoc/diagnostic jj invocation,
# so no jj commit is ever stranded on the empty identity. Written as a tanren-owned
# ~/.config/jj/config.toml (the tree is tanren-owned by the chown above).
RUN set -eu; \
  mkdir -p /home/tanren/.config/jj; \
  printf '[user]\nname = "Tanren Bot"\nemail = "bot@tanren.invalid"\n' > /home/tanren/.config/jj/config.toml; \
  chown -R tanren:tanren /home/tanren/.config/jj

RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
  && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config

COPY runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
