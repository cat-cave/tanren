// Shared "the composed scaffold bootstraps from a FRESH checkout" check for the
// template-fragment harnesses (task #84 — apex v63 halt regression).
//
// What apex v63 hit: the per-iteration `tanren-bootstrap` tier ran `just bootstrap`
// against a freshly composed scaffold (package.json present, NO pnpm-lock.yaml) and
// the runtime fragment's bootstrap recipe ran `pnpm install --frozen-lockfile` —
// pnpm refuses to install without a lockfile under `--frozen-lockfile`
// (`ERR_PNPM_NO_LOCKFILE`), the gate failed before the writer could do anything,
// and the writer was stranded in a rework loop trying to fix what was a composer
// bug. This check pins the doctrine in code so the failure mode cannot return:
// "every composed scaffold must bootstrap from a fresh checkout" (see
// `docs/roadmap/templating-system.md` §"every composed scaffold bootstraps from a
// fresh checkout"). The check is stack-agnostic — every common
// package-manager's "frozen install" mode is enumerated; a recipe that uses one
// without a matching committed lockfile is rejected.
//
// The check looks at the `bootstrap:` recipe body lines in the composed justfile.
// A frozen install line is rejected unless either (a) the matching lockfile is in
// the composed VFS, or (b) the line uses the EXPLICIT negated flag (e.g.
// `pnpm install --no-frozen-lockfile`).

import type { VirtualFileSystem } from "../../src/engine/templates/index.js";

/**
 * The frozen-install patterns this check forbids, with the lockfile they would
 * require to exist. Each entry is one (tool, frozen-install regex, lockfile
 * filename) tuple. New entries are added as new runtimes are introduced.
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
 * Assert the composed `justfile`'s `bootstrap:` recipe will succeed against a
 * FRESHLY checked-out workspace (the per-iteration `tanren-bootstrap` tier's
 * surface). Throws an `Error` whose message names the caller's `label` (test
 * combo slug, fragment id) + the broken recipe line + the missing lockfile so
 * the failure points at the specific entry that broke.
 *
 * The check enumerates every common package-manager's frozen-install mode and
 * rejects a recipe that uses one without a matching committed lockfile in the
 * composed VFS. A recipe that uses the negated/plain form (e.g.
 * `pnpm install --no-frozen-lockfile`, plain `bundle install`, `cargo fetch`)
 * is the doctrine-compliant primitive — it GENERATES the lockfile on first
 * run, which is then committed by the writer / available on subsequent runs.
 */
export function assertJustfileBootstrapsFromFreshCheckout(label: string, vfs: VirtualFileSystem): void {
  if (!vfs.has("justfile")) {
    throw new Error(
      `"${label}" composed VFS has no justfile — base/ is supposed to emit one ` +
        `unconditionally. This is a base-protected-files regression.`,
    );
  }
  const body = parseBootstrapRecipeLines(vfs.read("justfile"));
  for (const line of body) {
    for (const { tool, pattern, lockfile } of FROZEN_INSTALL_PATTERNS) {
      if (!pattern.test(line)) continue;
      // A committed lockfile makes the frozen install safe.
      if (vfs.has(lockfile)) continue;
      throw new Error(
        `"${label}" composed justfile bootstrap recipe contains ${JSON.stringify(line)} — ` +
          `this is a ${tool} frozen/locked install that requires "${lockfile}" to exist, but ` +
          `no "${lockfile}" is in the composed VFS. On a fresh checkout (the per-iteration ` +
          `tanren-bootstrap tier's surface) the install would fail before the writer can do ` +
          `anything (apex v63 ERR_PNPM_NO_LOCKFILE class — see task #84). Use the install ` +
          `primitive that GENERATES the lockfile on first run (e.g. ` +
          `\`pnpm install --no-frozen-lockfile\`, plain \`bundle install\`, \`cargo fetch\`).`,
      );
    }
  }
}
