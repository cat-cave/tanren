// ADDON — docker. Stack-agnostic: emits a Dockerfile + .dockerignore tuned to the
// chosen runtime (node-pnpm vs ruby-bundler). No dependency on a specific runtime;
// inspects `config.runtime` to choose the FROM image.
//
// FRESH-CHECKOUT BOOTSTRAP (audit finding #10 — extends task #84 / apex v63 to the
// docker build surface). The Dockerfile's install line must use the GENERATING
// primitive (e.g. `pnpm install --no-frozen-lockfile`, plain `bundle install`) —
// `--frozen-lockfile` / `--deployment` would `ERR_PNPM_NO_LOCKFILE` (or bundler's
// equivalent) on a freshly composed scaffold (no pnpm-lock.yaml / Gemfile.lock
// committed yet). PR #704's seed-grading writer is explicitly forbidden from
// regenerating or committing the lockfile, so a frozen install in the Dockerfile
// reproduces the v63 halt class inside the docker build. The same
// `assertScaffoldBootstrapsFromFreshCheckout` runtime helper (the lifted PR #701
// helper) that protects the justfile bootstrap recipe now scans Dockerfile RUN
// lines too — both surfaces share the same correctness contract.

import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const ADDON_DOCKER_ID = "addon-docker" as const;

export const DOCKERIGNORE = `node_modules
dist
.git
.env
.env.*
reports
coverage
.turbo
.stryker-tmp
`;

/**
 * Runtime-aware Dockerfile recipe — the single source of truth for the
 * host-image build surface. Shared with `deploy-fly.ts` so a Fly web app gets
 * the identical build recipe whether or not `addons: ["docker"]` is declared
 * (the deploy phase runs LAST, so when both apply, deploy-fly uses
 * `vfs.overwrite` against addon-docker's identical bytes — zero collision,
 * zero drift). Returns the ruby recipe for `"ruby-bundler"`, else the node
 * recipe. The content encodes audit-finding #10 + task #141 fixes — preserve
 * every comment and line.
 */
export function dockerfileFor(runtime: TemplateConfig["runtime"]): string {
  return runtime === "ruby-bundler" ? rubyDockerfile() : nodeDockerfile();
}

function nodeDockerfile(): string {
  return `# Multi-stage node-pnpm build — runs the project's \`just build\` and ships the dist/.
# Install line uses --no-frozen-lockfile so the first build (no committed lockfile
# yet) succeeds; pnpm generates the lockfile and still respects it on subsequent runs.
# See addon-docker.ts header comment for the audit-finding-#10 rationale.
# ENV CI=true mirrors the base justfile's \`export CI := "true"\` — pnpm 11 respects
# it and skips the modules-directory purge confirmation that otherwise HALTS with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY inside a docker build (task #141 —
# apex v71/v78 halt class). Downstream tools (next.js build, turborepo) key off
# CI=true too.
FROM node:24-alpine AS builder
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
CMD ["node", "dist/index.js"]
`;
}

function rubyDockerfile(): string {
  return `# Ruby-bundler build — installs gems, exposes the rake-built artifact.
# Plain \`bundle install\` (no --deployment / --frozen) — generates Gemfile.lock on
# first run, matches the runtime fragment's \`just bootstrap\` recipe. ENV CI=true
# mirrors the base justfile's \`export CI := "true"\` — a non-interactive signal
# that build tools respect (task #141).
FROM ruby:3.4-alpine
ENV CI=true
RUN apk add --no-cache build-base
WORKDIR /app
COPY Gemfile Gemfile.lock* ./
RUN bundle install
COPY . .
CMD ["bundle", "exec", "rake"]
`;
}

export const addonDockerFragment: Fragment = {
  id: ADDON_DOCKER_ID,
  version: "1.0.0",
  kind: "addon",
  contract: {},
  async apply(vfs: VirtualFileSystem, config: TemplateConfig): Promise<void> {
    vfs.write("Dockerfile", dockerfileFor(config.runtime));
    vfs.write(".dockerignore", DOCKERIGNORE);
  },
};
