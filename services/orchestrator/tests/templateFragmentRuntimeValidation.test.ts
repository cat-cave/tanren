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
import { assertScaffoldBootstrapsFromFreshCheckout } from "../src/engine/templates/fragments/runtimeValidation.js";
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
