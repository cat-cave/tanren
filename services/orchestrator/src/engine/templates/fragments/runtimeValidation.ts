// RUNTIME FRAGMENT-COMPOSITION VALIDATORS (audit finding #12 — lift from
// tests/helpers/ so the live fragment-authoring smoke pipeline catches the same
// classes PR #696's + PR #701's static harnesses catch).
//
// Both `assertComposedCiYmlParsesAsCiConfigV1` (PR #696, apex v62 halt class)
// and `assertScaffoldBootstrapsFromFreshCheckout` (PR #701, apex v63 halt class)
// were originally test-only helpers in `tests/helpers/`. The static matrix +
// isolation harnesses ran them, but the LIVE fragment-authoring smoke pipeline
// did NOT — so an LLM-authored runtime fragment that emitted
// `pnpm install --frozen-lockfile` or a malformed `.tanren/ci.yml` passed
// smoke and persisted, and the next live run reproduced the halt. The 1-line
// re-export shims that lived at `tests/helpers/templateCiYmlSchemaCheck.ts` +
// `tests/helpers/templateFreshBootstrapCheck.ts` were the audit-N1 finding
// (two import paths for one helper); the writer-seam doctrine sweep deleted
// them, so this file is now the SOLE import path.
//
// Living in a runtime module makes the correctness contract a SINGLE INTENDED
// PATH: the same assertion runs in (a) the per-fragment isolation test,
// (b) the cross-product matrix test, AND (c) the live fragment-authoring smoke
// pipeline. The "test-only check vs live skip" mismatch is the half-measure this
// extraction eliminates (the user's standing rule: regressions caught by static
// harnesses must also be caught by live smoke).
//
// SCAFFOLD-BOOTSTRAP SCOPE (audit finding #10). The fresh-checkout assertion now
// scans the justfile's `bootstrap:` recipe AND Dockerfile (or any *.Dockerfile)
// `RUN` lines — both are surfaces that execute the install commands against a
// freshly checked-out workspace (the justfile target during the per-iteration
// `tanren-bootstrap` tier, the Dockerfile during a `docker build`). A frozen
// install primitive on either surface that lacks a committed lockfile reproduces
// the v63 halt class. The matrix harness exercises the docker addon via its
// powerset enumeration, so a future Dockerfile regression is caught there too.

import { resolveCiConfig } from "../../ci/resolve.js";
import type { VirtualFileSystem } from "./types.js";

// ── CI.YML SCHEMA CHECK (lifted from tests/helpers/templateCiYmlSchemaCheck.ts) ──

/** Parse the composed `.tanren/ci.yml` against `CiConfigV1` — the exact parse the
 * runtime gate runs (workflow/gate/resolveGateConfig.ts → ci/resolve.ts). A
 * fragment that emits an unparseable shape fails here instead of escaping into a
 * live run (apex v62 halt class). Throws an `Error` whose message names the
 * caller's `label` (test combo slug, fragment id) so the failure points at the
 * specific entry that broke. */
export function assertComposedCiYmlParsesAsCiConfigV1(label: string, vfs: VirtualFileSystem): void {
  try {
    resolveCiConfig(vfs.read(".tanren/ci.yml"));
  } catch (cause) {
    throw new Error(
      `"${label}" composed .tanren/ci.yml that FAILED CiConfigV1.safeParse — ` +
        `the runtime gate would reject this at the tanren-ci-config validate step ` +
        `(apex v62 halt class). Error: ${String(cause)}`,
      { cause },
    );
  }
}

// ── FRESH-CHECKOUT BOOTSTRAP CHECK (lifted from
//    tests/helpers/templateFreshBootstrapCheck.ts; extended to Dockerfile scope) ──

/**
 * The frozen-install patterns the fresh-checkout assertion forbids, with the
 * lockfile they would require to exist. Each entry is one (tool, frozen-install
 * regex, lockfile filename) tuple. New entries are added as new runtimes are
 * introduced.
 *
 * The regex is intentionally narrow — it matches the EXPLICIT frozen flag, not
 * the bare install. `pnpm install` (without a flag) is a fresh-bootstrap-safe
 * primitive that GENERATES the lockfile on first run; `--frozen-lockfile`
 * refuses to install without one. (Note: the substring `--frozen-lockfile` is
 * NOT present in `--no-frozen-lockfile` — they share only `frozen-lockfile`
 * after a different prefix — so a simple substring/regex match on
 * `--frozen-lockfile` correctly excludes the negated form.)
 */
const FROZEN_INSTALL_PATTERNS: readonly {
  readonly tool: string;
  readonly pattern: RegExp;
  readonly lockfile: string;
}[] = [
  { tool: "pnpm", pattern: /\bpnpm\s+(i|install)\b[^\n]*--frozen-lockfile\b/u, lockfile: "pnpm-lock.yaml" },
  { tool: "npm", pattern: /\bnpm\s+ci\b/u, lockfile: "package-lock.json" },
  {
    tool: "yarn",
    pattern: /\byarn\s+install\b[^\n]*(?:--immutable|--frozen-lockfile)\b/u,
    lockfile: "yarn.lock",
  },
  { tool: "cargo", pattern: /\bcargo\s+(build|install|fetch|test)\b[^\n]*--locked\b/u, lockfile: "Cargo.lock" },
  { tool: "bundler", pattern: /\bbundle\s+install\b[^\n]*(?:--deployment|--frozen)\b/u, lockfile: "Gemfile.lock" },
  { tool: "uv", pattern: /\buv\s+sync\b[^\n]*--frozen\b/u, lockfile: "uv.lock" },
  { tool: "uv", pattern: /\buv\s+sync\b[^\n]*--locked\b/u, lockfile: "uv.lock" },
];

/**
 * Extract the body lines of the `bootstrap:` recipe from a composed justfile.
 * Returns each non-empty body line (without the leading two-space indent the
 * composer's `processJustfile` adds). Returns `[]` if no `bootstrap:` target is
 * present (base/ always emits one — an empty result here is itself a regression).
 */
function parseBootstrapRecipeLines(justfile: string): readonly string[] {
  const lines = justfile.split("\n");
  const bootstrapIdx = lines.findIndex((l) => /^bootstrap\s*:\s*$/u.test(l));
  if (bootstrapIdx === -1) return [];
  const body: string[] = [];
  for (let i = bootstrapIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Stop at the next target header (lines that start with a non-whitespace
    // char after the bootstrap recipe body, i.e. the next target's "name:" line
    // or a top-level comment / blank that prefixes the next target).
    if (line.length === 0) {
      // A blank line separates targets; the next non-blank is a target header.
      break;
    }
    if (/^[^\s]/u.test(line)) {
      // A line that begins flush-left is either the next target or a comment;
      // the recipe body ends here.
      break;
    }
    body.push(line.trim());
  }
  return body;
}

/**
 * Extract `RUN` line bodies from a Dockerfile. Concatenates continuation lines
 * (lines ending with `\`) into a single logical statement so a multi-line
 * `RUN pnpm install \` `--frozen-lockfile` matches the same patterns the inline
 * form does. Returns the joined line bodies (without the `RUN ` prefix).
 *
 * A Dockerfile typically lacks the explicit lockfile presence the justfile
 * recipe has — the `COPY package.json pnpm-lock.yaml* ./` line uses a glob, so
 * the lockfile may or may not exist at build time. The check rejects any frozen
 * primitive in a `RUN` line unconditionally; the operator opts back into a
 * frozen install by using the negated/plain form (the doctrine: the GENERATING
 * primitive is the single intended way).
 */
function parseDockerfileRunLines(dockerfile: string): readonly string[] {
  const lines = dockerfile.split("\n");
  const runs: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!/^\s*RUN\b/u.test(line)) {
      i += 1;
      continue;
    }
    // Strip the `RUN ` prefix (allow leading whitespace + RUN + optional args).
    let body = line.replace(/^\s*RUN\s*/u, "");
    // Join continuations.
    while (body.trimEnd().endsWith("\\") && i + 1 < lines.length) {
      body = `${body.trimEnd().slice(0, -1)} ${(lines[i + 1] ?? "").trim()}`;
      i += 1;
    }
    runs.push(body);
    i += 1;
  }
  return runs;
}

/** True when the composed VFS has a Dockerfile-shaped path the scanner should
 * inspect. `Dockerfile` (the canonical name) and any `*.Dockerfile` variant
 * (e.g. `web.Dockerfile`, `api.Dockerfile`) are covered. */
function dockerfilePaths(vfs: VirtualFileSystem): readonly string[] {
  const flat = vfs.toFlatMap();
  return Object.keys(flat).filter((p) => p === "Dockerfile" || p.endsWith(".Dockerfile") || p.endsWith("/Dockerfile"));
}

/**
 * Assert the composed scaffold will BOOTSTRAP cleanly against a FRESHLY
 * checked-out workspace — both the per-iteration `tanren-bootstrap` tier's
 * surface (the justfile's `bootstrap:` recipe) AND any Dockerfile's `RUN`
 * lines (the docker build's surface). Throws an `Error` whose message names
 * the caller's `label` (test combo slug, fragment id) + the broken line + the
 * missing lockfile so the failure points at the specific entry that broke.
 *
 * The check enumerates every common package-manager's frozen-install mode and
 * rejects a recipe/RUN that uses one without a matching committed lockfile in
 * the composed VFS. A line that uses the negated/plain form (e.g.
 * `pnpm install --no-frozen-lockfile`, plain `bundle install`, `cargo fetch`)
 * is the doctrine-compliant primitive — it GENERATES the lockfile on first
 * run, which is then committed by the writer / available on subsequent runs.
 *
 * Renamed from `assertJustfileBootstrapsFromFreshCheckout` to reflect the
 * broader scope (justfile + Dockerfile). The doctrine: the composed scaffold
 * bootstraps from a fresh checkout regardless of WHICH surface runs the install.
 */
export function assertScaffoldBootstrapsFromFreshCheckout(label: string, vfs: VirtualFileSystem): void {
  if (!vfs.has("justfile")) {
    throw new Error(
      `"${label}" composed VFS has no justfile — base/ is supposed to emit one ` +
        `unconditionally. This is a base-protected-files regression.`,
    );
  }
  const justfileBody = parseBootstrapRecipeLines(vfs.read("justfile"));
  assertNoFrozenPrimitives(label, vfs, "justfile bootstrap recipe", justfileBody);

  // Scan every Dockerfile in the composed VFS. The addon-docker fragment emits a
  // canonical `Dockerfile`; future addons (e.g. a `web.Dockerfile` + `api.Dockerfile`
  // split) are picked up automatically by the *.Dockerfile suffix match.
  for (const path of dockerfilePaths(vfs)) {
    const runs = parseDockerfileRunLines(vfs.read(path));
    assertNoFrozenPrimitives(label, vfs, `Dockerfile ${path}`, runs);
  }
}

function assertNoFrozenPrimitives(
  label: string,
  vfs: VirtualFileSystem,
  surface: string,
  lines: readonly string[],
): void {
  for (const line of lines) {
    for (const { tool, pattern, lockfile } of FROZEN_INSTALL_PATTERNS) {
      if (!pattern.test(line)) continue;
      // A committed lockfile makes the frozen install safe.
      if (vfs.has(lockfile)) continue;
      throw new Error(
        `"${label}" composed ${surface} contains ${JSON.stringify(line)} — ` +
          `this is a ${tool} frozen/locked install that requires "${lockfile}" to exist, but ` +
          `no "${lockfile}" is in the composed VFS. On a fresh checkout (the per-iteration ` +
          `tanren-bootstrap tier's surface OR a \`docker build\` against a freshly committed ` +
          `scaffold) the install would fail before the writer can do anything (apex v63 ` +
          `ERR_PNPM_NO_LOCKFILE class — see task #84 + audit finding #10). Use the install ` +
          `primitive that GENERATES the lockfile on first run (e.g. ` +
          `\`pnpm install --no-frozen-lockfile\`, plain \`bundle install\`, \`cargo fetch\`).`,
      );
    }
  }
}

// ── NON-INTERACTIVE PNPM INSTALL CHECK (task #141 — apex v71/v78 halt class) ──
//
// pnpm 11 aborts a modules-directory purge on a TTY-less environment with
// `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules
// directory due to no TTY`. The tanren-bootstrap tier runs `just bootstrap`
// over SSH (no PTY), so any pnpm install that would trigger a modules purge
// halts the outer loop. apex v71 hit this on run 1 (task #141 filed); apex v78
// hit it again after task #732's writer watchdog widening pushed the loop into
// the same halt class 18 iterations in a row — the halt is the outer-loop
// wedge, not a writer failure.
//
// The doctrine fix: EVERY surface that runs `pnpm install` (justfile recipe,
// Dockerfile RUN line) must carry a non-interactive signal — either
//   (a) `CI=true` exported into the invocation's env (industry-standard signal;
//       pnpm respects it and skips the purge confirmation, and downstream tools
//       like next.js/turborepo/husky key off it too), OR
//   (b) `--config.confirmModulesPurge=false` on the pnpm invocation itself.
//
// The base fragment's justfile top-level `export CI := "true"` covers every
// recipe (bootstrap + tier-* + build + mutation) — the assertion below checks
// that both the file-scope signal AND the invocation-level signal are honored
// per-line so a future writer that overrides the base justfile without carrying
// the export forward fails the check loudly instead of reproducing the halt.

/** True when `line` carries a non-interactive signal for pnpm install — either
 * `CI=true` inline prefix, or the `--config.confirmModulesPurge=false` flag. */
function lineHasInlineNonInteractiveSignal(line: string): boolean {
  return (
    /\bCI\s*=\s*(?:true|1|"true"|'true')\b/u.test(line) || /--config\.confirmModulesPurge\s*=\s*false\b/u.test(line)
  );
}

/** True when the file (justfile / Dockerfile) declares CI=true at file scope so
 * every recipe or subsequent RUN line inherits it. Covers just's
 * `export CI := "true"` directive and Dockerfile's `ENV CI=true` / `ENV CI true`. */
function fileHasFileScopeCiExport(content: string): boolean {
  // just: `export CI := "true"` (with optional whitespace variants).
  if (/^\s*export\s+CI\s*:=\s*"true"\s*$/mu.test(content)) return true;
  // Dockerfile: `ENV CI=true` or `ENV CI true`.
  if (/^\s*ENV\s+CI\s*[=\s]\s*(?:true|1|"true")\s*$/mu.test(content)) return true;
  return false;
}

/** A `pnpm install` — the invocation that triggers the modules-purge prompt.
 * Matches `pnpm install`, `pnpm i`, and `pnpm i <deps>`; deliberately narrow so
 * `pnpm test` / `pnpm build` / `pnpm stryker run` (which don't purge modules)
 * don't get flagged. */
const PNPM_INSTALL_REGEX = /\bpnpm\s+(?:i|install)\b/u;

/**
 * Assert every `pnpm install` invocation the composed scaffold emits will run
 * NON-INTERACTIVELY on a TTY-less environment (the tanren-bootstrap SSH tier's
 * surface + any Dockerfile RUN line inside `docker build`). Throws an `Error`
 * whose message names the `label` + broken surface + broken line so the failure
 * points at the specific entry that broke.
 *
 * A surface passes when the pnpm install line carries an inline signal
 * (`CI=true` prefix or `--config.confirmModulesPurge=false` flag) OR the file
 * scope declares one (just: `export CI := "true"`, Dockerfile: `ENV CI=true`).
 * The base fragment covers this at file scope for the justfile; the addon-docker
 * fragment covers it for the Dockerfile. A live-authored runtime that overrides
 * either without carrying the signal forward fails here loudly instead of
 * reproducing the v71/v78 halt in the outer loop.
 */
export function assertPnpmInstallIsNonInteractive(label: string, vfs: VirtualFileSystem): void {
  // Justfile surface. Every non-comment line in every recipe is a potential
  // pnpm install site; the file-scope `export CI := "true"` covers all of them.
  if (vfs.has("justfile")) {
    const justfile = vfs.read("justfile");
    const fileScope = fileHasFileScopeCiExport(justfile);
    for (const rawLine of justfile.split("\n")) {
      // Strip trailing comment (task #103 doctrine): `# ...` to end-of-line.
      const line = rawLine.replace(/#.*$/u, "").trim();
      if (line.length === 0) continue;
      if (!PNPM_INSTALL_REGEX.test(line)) continue;
      if (fileScope) continue;
      if (lineHasInlineNonInteractiveSignal(line)) continue;
      throw new Error(
        `"${label}" composed justfile contains a pnpm install line ${JSON.stringify(line)} ` +
          `that lacks a non-interactive signal — the tanren-bootstrap tier runs \`just bootstrap\` ` +
          `over SSH (no PTY), and pnpm 11 aborts a modules-directory purge with ` +
          `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY on the first inconsistent-state re-run ` +
          `(apex v71/v78 halt class — see task #141). Fix by either (a) declaring ` +
          `\`export CI := "true"\` at the top of the justfile (the base fragment does this ` +
          `unconditionally) OR (b) prefixing the invocation with \`CI=true\` OR (c) passing ` +
          `\`--config.confirmModulesPurge=false\` on the pnpm call.`,
      );
    }
  }

  // Dockerfile surface — same signal, different vocabulary (`ENV CI=true`).
  for (const path of dockerfilePaths(vfs)) {
    const dockerfile = vfs.read(path);
    const fileScope = fileHasFileScopeCiExport(dockerfile);
    for (const run of parseDockerfileRunLines(dockerfile)) {
      if (!PNPM_INSTALL_REGEX.test(run)) continue;
      if (fileScope) continue;
      if (lineHasInlineNonInteractiveSignal(run)) continue;
      throw new Error(
        `"${label}" composed Dockerfile ${path} contains a pnpm install RUN line ` +
          `${JSON.stringify(run)} that lacks a non-interactive signal — a \`docker build\` ` +
          `runs without a PTY, and pnpm 11 aborts the modules-directory purge with ` +
          `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY (task #141). Fix by declaring ` +
          `\`ENV CI=true\` above the RUN line (the addon-docker fragment does this) ` +
          `OR prefixing the invocation with \`CI=true\` OR passing ` +
          `\`--config.confirmModulesPurge=false\`.`,
      );
    }
  }
}
