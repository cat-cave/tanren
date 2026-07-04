// Direct tests for the lifted runtime validators
// (`src/engine/templates/fragments/runtimeValidation.ts`).
//
// The validators ALREADY have indirect coverage through the matrix + isolation
// harnesses (templateFragmentMatrixCoverage, templateFragmentIsolation) AND
// the fragment-authoring smoke pipeline (fragmentAuthoringRun.test.ts). This
// file pins the EDGE behaviors that the indirect coverage doesn't isolate:
//
//   - Dockerfile RUN-line scanning (audit finding #10) — the matrix harness
//     exercises the addon-docker fragment, but proving the assertion's NEW
//     scope (Dockerfile in addition to justfile) needs a dedicated case so a
//     future refactor that drops the Dockerfile branch fails here loudly.
//   - Multi-line RUN continuation — a `RUN pnpm install \` continued on the
//     next line must be reassembled before pattern-matching (Dockerfile
//     authors split long commands across lines; the scanner must follow).
//   - Negated/plain primitives pass — `--no-frozen-lockfile`, plain
//     `bundle install`, `cargo fetch` are the doctrine-compliant forms and
//     MUST NOT trip the assertion.
//   - A committed lockfile makes a frozen primitive safe — the carve-out
//     exists for the future-proofed "second compose with a committed
//     lockfile" case; pin it so the scanner's lockfile-presence check stays
//     honest.

import { describe, expect, it } from "vitest";
import {
  assertPnpmInstallIsNonInteractive,
  assertScaffoldBootstrapsFromFreshCheckout,
} from "../src/engine/templates/fragments/runtimeValidation.js";
import { VirtualFileSystem } from "../src/engine/templates/fragments/types.js";

function vfsWith(files: Record<string, string>): VirtualFileSystem {
  const vfs = new VirtualFileSystem();
  for (const [path, content] of Object.entries(files)) vfs.write(path, content);
  return vfs;
}

const SAFE_JUSTFILE = `bootstrap:
  pnpm install --no-frozen-lockfile

tier-1:
  pnpm lint
`;

describe("assertScaffoldBootstrapsFromFreshCheckout — audit finding #10 (Dockerfile scope)", () => {
  it("REJECTS a Dockerfile RUN line that uses `pnpm install --frozen-lockfile` without a committed pnpm-lock.yaml", () => {
    const vfs = vfsWith({
      justfile: SAFE_JUSTFILE,
      Dockerfile: `FROM node:24-alpine
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
`,
    });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("docker-frozen-no-lock", vfs)).toThrow(
      /Dockerfile.*pnpm install --frozen-lockfile/u,
    );
  });

  it("REJECTS a Dockerfile RUN line that uses `bundle install --deployment` without a committed Gemfile.lock", () => {
    const vfs = vfsWith({
      justfile: SAFE_JUSTFILE,
      Dockerfile: `FROM ruby:3.4-alpine
COPY Gemfile Gemfile.lock* ./
RUN bundle install --deployment
`,
    });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("docker-bundler-deployment", vfs)).toThrow(
      /Dockerfile.*bundle install --deployment/u,
    );
  });

  it("REASSEMBLES a multi-line `RUN ... \\` continuation before pattern-matching", () => {
    const vfs = vfsWith({
      justfile: SAFE_JUSTFILE,
      Dockerfile: `FROM node:24-alpine
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install \\
  --frozen-lockfile
`,
    });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("docker-frozen-multiline", vfs)).toThrow(
      /--frozen-lockfile/u,
    );
  });

  it("ACCEPTS a Dockerfile RUN line that uses the generating primitive `pnpm install --no-frozen-lockfile`", () => {
    const vfs = vfsWith({
      justfile: SAFE_JUSTFILE,
      Dockerfile: `FROM node:24-alpine
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile
`,
    });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("docker-no-frozen", vfs)).not.toThrow();
  });

  it("ACCEPTS plain `bundle install` (no --deployment / --frozen) in a Dockerfile RUN line", () => {
    const vfs = vfsWith({
      justfile: SAFE_JUSTFILE,
      Dockerfile: `FROM ruby:3.4-alpine
COPY Gemfile Gemfile.lock* ./
RUN bundle install
`,
    });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("docker-plain-bundle", vfs)).not.toThrow();
  });

  it("a COMMITTED pnpm-lock.yaml makes a frozen-lockfile primitive safe", () => {
    // The carve-out documented in the helper — if the lockfile is already in
    // the composed VFS, frozen install can succeed. Pin it so a future scanner
    // refactor doesn't accidentally remove the presence check.
    const vfs = vfsWith({
      justfile: SAFE_JUSTFILE,
      Dockerfile: `FROM node:24-alpine
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
`,
      "pnpm-lock.yaml": "lockfileVersion: '6.0'\n",
    });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("docker-frozen-with-lock", vfs)).not.toThrow();
  });

  it("scans any `*.Dockerfile` (e.g. web.Dockerfile, api.Dockerfile), not just the canonical name", () => {
    const vfs = vfsWith({
      justfile: SAFE_JUSTFILE,
      "web.Dockerfile": `FROM node:24-alpine
RUN pnpm install --frozen-lockfile
`,
    });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("docker-web-variant", vfs)).toThrow(
      /Dockerfile web\.Dockerfile.*pnpm install --frozen-lockfile/u,
    );
  });
});

describe("assertScaffoldBootstrapsFromFreshCheckout — justfile scope (regression pin for PR #701)", () => {
  it("REJECTS a justfile bootstrap recipe with `npm ci` and no package-lock.json", () => {
    const vfs = vfsWith({
      justfile: `bootstrap:
  npm ci
`,
    });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("justfile-npm-ci", vfs)).toThrow(
      /justfile bootstrap recipe.*npm ci/u,
    );
  });

  it("REJECTS a justfile bootstrap recipe with `cargo build --locked` and no Cargo.lock", () => {
    const vfs = vfsWith({
      justfile: `bootstrap:
  cargo build --locked
`,
    });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("justfile-cargo-locked", vfs)).toThrow(/Cargo\.lock/u);
  });

  it("THROWS LOUDLY when the composed VFS has no justfile (base-protected-files regression)", () => {
    const vfs = vfsWith({ "src/demo.ts": "// nothing" });
    expect(() => assertScaffoldBootstrapsFromFreshCheckout("no-justfile", vfs)).toThrow(
      /no justfile.*base-protected-files/u,
    );
  });
});

describe("assertPnpmInstallIsNonInteractive — task #141 (apex v71/v78 halt class)", () => {
  it('REJECTS a justfile with a bare `pnpm install` and no `export CI := "true"` at file scope', () => {
    // The regression this pins: a future writer overrides the base justfile,
    // drops the `export CI := "true"` line, but still runs pnpm install. Over
    // SSH (no PTY) pnpm 11 halts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
    const vfs = vfsWith({
      justfile: `set shell := ["bash", "-euo", "pipefail", "-c"]

bootstrap:
  pnpm install --no-frozen-lockfile
`,
    });
    expect(() => assertPnpmInstallIsNonInteractive("justfile-no-signal", vfs)).toThrow(
      /pnpm install.*non-interactive signal/u,
    );
  });

  it('ACCEPTS a justfile that declares `export CI := "true"` at file scope', () => {
    // The base fragment's fix: file-scope export covers every recipe.
    const vfs = vfsWith({
      justfile: `set shell := ["bash", "-euo", "pipefail", "-c"]
export CI := "true"

bootstrap:
  pnpm install --no-frozen-lockfile

tier-2:
  pnpm test
`,
    });
    expect(() => assertPnpmInstallIsNonInteractive("justfile-file-scope-ci", vfs)).not.toThrow();
  });

  it("ACCEPTS an inline `CI=true` prefix on the pnpm install invocation", () => {
    const vfs = vfsWith({
      justfile: `bootstrap:
  CI=true pnpm install --no-frozen-lockfile
`,
    });
    expect(() => assertPnpmInstallIsNonInteractive("justfile-inline-ci", vfs)).not.toThrow();
  });

  it("ACCEPTS an inline `--config.confirmModulesPurge=false` flag on the pnpm install invocation", () => {
    // The Option B fallback documented in the task #141 fix: the surgical flag
    // instead of the industry-standard env var.
    const vfs = vfsWith({
      justfile: `bootstrap:
  pnpm install --no-frozen-lockfile --config.confirmModulesPurge=false
`,
    });
    expect(() => assertPnpmInstallIsNonInteractive("justfile-inline-flag", vfs)).not.toThrow();
  });

  it("REJECTS a Dockerfile RUN pnpm install line without ENV CI=true above it", () => {
    // The regression this pins: an addon-docker regression that drops the
    // `ENV CI=true` line but still runs `pnpm install` inside `docker build`.
    // Docker's build container also has no PTY.
    const vfs = vfsWith({
      justfile: `export CI := "true"

bootstrap:
  echo skip
`,
      Dockerfile: `FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
`,
    });
    expect(() => assertPnpmInstallIsNonInteractive("docker-no-env", vfs)).toThrow(
      /Dockerfile.*non-interactive signal/u,
    );
  });

  it("ACCEPTS a Dockerfile with `ENV CI=true` above the pnpm install RUN line", () => {
    // The addon-docker fix: ENV CI=true at file scope covers every subsequent
    // RUN line in the same build stage.
    const vfs = vfsWith({
      justfile: `export CI := "true"

bootstrap:
  echo skip
`,
      Dockerfile: `FROM node:24-alpine
ENV CI=true
WORKDIR /app
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
`,
    });
    expect(() => assertPnpmInstallIsNonInteractive("docker-env-ci", vfs)).not.toThrow();
  });

  it("does not flag non-install pnpm invocations (`pnpm test`, `pnpm build`, `pnpm stryker run`)", () => {
    // The narrow scope of PNPM_INSTALL_REGEX: only `pnpm install` / `pnpm i`
    // triggers the modules-purge prompt. `pnpm test` etc. never do; flagging
    // them would force ceremonial `CI=true` prefixes everywhere for no reason.
    const vfs = vfsWith({
      justfile: `set shell := ["bash", "-euo", "pipefail", "-c"]

bootstrap:
  echo bootstrap

tier-2:
  pnpm test

tier-3:
  pnpm build

mutation:
  pnpm stryker run
`,
    });
    expect(() => assertPnpmInstallIsNonInteractive("justfile-non-install", vfs)).not.toThrow();
  });

  it("does not flag comment-only lines that mention `pnpm install`", () => {
    // Task #103 stripping doctrine: `# ...` to end-of-line is a comment.
    const vfs = vfsWith({
      justfile: `bootstrap:
  # historical: pnpm install used to run here
  echo bootstrap
`,
    });
    expect(() => assertPnpmInstallIsNonInteractive("justfile-comment-only", vfs)).not.toThrow();
  });

  it("ACCEPTS `pnpm i` short form under the same signal", () => {
    // A writer might use the terse form. Same halt class applies.
    const vfs = vfsWith({
      justfile: `bootstrap:
  CI=true pnpm i
`,
    });
    expect(() => assertPnpmInstallIsNonInteractive("justfile-short-form", vfs)).not.toThrow();
  });
});
