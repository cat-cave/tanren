// Deriving a fragment's implicit `dependsOn` from its parsed ops (audit findings
// #11 + H2). Any op whose effect implies a runtime MUST surface that runtime — a
// runtime fragment is its own runtime so we never self-depend. Implications:
//  - `addPackageJsonDep` / `addPackageJsonDevDep` ⇒ runtime-node-pnpm.
//  - `vfs.write|overwrite("package.json", …)` ⇒ runtime-node-pnpm (a fragment
//    writing pkg.json directly bypasses the addPackageJsonDep API).
//  - `vfs.write|overwrite("Gemfile", …)` ⇒ runtime-ruby-bundler.
//  - `vfs.write|overwrite("pyproject.toml" | "requirements.txt", …)` ⇒
//    runtime-python-uv.
//  - `vfs.write|overwrite("go.mod", …)` ⇒ runtime-go.
//  - `vfs.write|overwrite("Cargo.toml", …)` ⇒ runtime-rust-cargo.
//  - `vfs.appendToJustfileTarget` lines containing a pnpm / npm / yarn / npx /
//    node token ⇒ runtime-node-pnpm; bundle / gem / ruby ⇒ runtime-ruby-bundler;
//    pip / python / python3 / poetry / uv / pipx ⇒ runtime-python-uv; go ⇒
//    runtime-go; cargo / rustc ⇒ runtime-rust-cargo.
//
// The composer's `dependency_runtime_mismatch` then fails LOUD on a misaligned
// pair, instead of silently dropping the mismatch + producing a broken VFS.
//
// NOTE on the non-Node runtime ids: the shipped library does not (yet) carry
// a `runtime-python-uv` / `runtime-go` / `runtime-rust-cargo` fragment. Emitting
// the implicit dependsOn anyway is INTENTIONAL — a writer that authors a
// non-Node fragment against a Node runtime must trip the composer's runtime
// mismatch check (or a downstream `library.require` throw) so the operator sees
// the correct cause (fragment targets the wrong runtime) instead of a silent
// half-composed VFS. When a real Python/Go/Rust runtime fragment ships the ids
// automatically become resolvable.

import { RUNTIME_NODE_PNPM_ID, RUNTIME_RUBY_BUNDLER_ID } from "./library/index.js";
import type { FragmentSpec } from "./selectFragmentConfig.js";
import type { FragmentOp } from "./unifiedLibrary.js";

/** Canonical runtime id for a Python-tooled fragment. The `uv` head is picked
 * because uv is the modern Python resolver + package manager (mirrors the
 * `python-uv` head in `runtimeLanguage.ts`). */
export const RUNTIME_PYTHON_UV_ID = "runtime-python-uv" as const;
/** Canonical runtime id for a Go-tooled fragment (single canonical shape —
 * go modules are the sole modern Go dependency system). */
export const RUNTIME_GO_ID = "runtime-go" as const;
/** Canonical runtime id for a Rust-tooled fragment. `cargo` is Rust's
 * standard resolver + build tool. */
export const RUNTIME_RUST_CARGO_ID = "runtime-rust-cargo" as const;

export function deriveImplicitDependsOn(ops: readonly FragmentOp[], spec: FragmentSpec): readonly string[] {
  // A runtime fragment IS the runtime — never imply a self-dependency. Bail
  // before the per-op walk so a runtime-fragment that happens to author its
  // own package.json / Gemfile doesn't get a circular self-derived dep.
  if (spec.kind === "runtime") return [];
  const implied = new Set<string>();
  for (const op of ops) {
    if (op.kind === "dep" || op.kind === "devDep") {
      implied.add(RUNTIME_NODE_PNPM_ID);
      continue;
    }
    if (op.kind === "write" || op.kind === "overwrite") {
      if (op.path === "package.json") implied.add(RUNTIME_NODE_PNPM_ID);
      else if (op.path === "Gemfile") implied.add(RUNTIME_RUBY_BUNDLER_ID);
      else if (op.path === "pyproject.toml" || op.path === "requirements.txt") implied.add(RUNTIME_PYTHON_UV_ID);
      else if (op.path === "go.mod") implied.add(RUNTIME_GO_ID);
      else if (op.path === "Cargo.toml") implied.add(RUNTIME_RUST_CARGO_ID);
      continue;
    }
    if (op.kind === "just") {
      if (op.lines.some((line) => lineHasNodeToolingToken(line))) implied.add(RUNTIME_NODE_PNPM_ID);
      if (op.lines.some((line) => lineHasRubyToolingToken(line))) implied.add(RUNTIME_RUBY_BUNDLER_ID);
      if (op.lines.some((line) => lineHasPythonToolingToken(line))) implied.add(RUNTIME_PYTHON_UV_ID);
      if (op.lines.some((line) => lineHasGoToolingToken(line))) implied.add(RUNTIME_GO_ID);
      if (op.lines.some((line) => lineHasRustToolingToken(line))) implied.add(RUNTIME_RUST_CARGO_ID);
    }
  }
  return [...implied];
}

/** Strip the justfile comment portion of a line before token-matching (task
 * #103). Justfile/shell comments are `#` to end-of-line, so `# pnpm here is
 * historical` or `mkdir output # was: npm` would otherwise false-positive the
 * tooling-token regex. A `#` at column 0 OR preceded by whitespace begins a
 * comment; a `#` mid-token (rare quoted-string case) is left alone. */
function stripJustfileComment(line: string): string {
  const match = line.match(/(?:^|\s)#/u);
  if (match === null || match.index === undefined) return line;
  return line.slice(0, match.index);
}

/** A justfile line invokes node tooling — pnpm / npm / yarn / npx / node — as a
 * whole-word token (not a substring, so `node` does NOT match `linode`). The
 * comment portion is stripped FIRST (task #103) so `# pnpm here is historical`
 * does NOT derive the node runtime. */
function lineHasNodeToolingToken(line: string): boolean {
  const code = stripJustfileComment(line);
  return /(?:^|[\s|;&"'`(])(?:pnpm|npm|yarn|npx|node)(?=$|[\s|;&"'`)])/u.test(code);
}

/** A justfile line invokes ruby tooling — bundle / gem / ruby — as a whole-word
 * token. Mirrors {@link lineHasNodeToolingToken} (comment strip + whole-word
 * regex). */
function lineHasRubyToolingToken(line: string): boolean {
  const code = stripJustfileComment(line);
  return /(?:^|[\s|;&"'`(])(?:bundle|gem|ruby)(?=$|[\s|;&"'`)])/u.test(code);
}

/** A justfile line invokes python tooling — pip / python / python3 / poetry /
 * uv / pipx — as a whole-word token. Mirrors {@link lineHasNodeToolingToken}
 * (comment strip + whole-word regex). Note `python3` is included as a distinct
 * whole-word alternative because it's the common invocation on most operator
 * hosts + does not overlap with the `python` prefix under whole-word matching. */
function lineHasPythonToolingToken(line: string): boolean {
  const code = stripJustfileComment(line);
  return /(?:^|[\s|;&"'`(])(?:pip|python3|python|poetry|uv|pipx)(?=$|[\s|;&"'`)])/u.test(code);
}

/** A justfile line invokes go tooling — the `go` binary — as a whole-word
 * token. Mirrors {@link lineHasNodeToolingToken}. */
function lineHasGoToolingToken(line: string): boolean {
  const code = stripJustfileComment(line);
  return /(?:^|[\s|;&"'`(])go(?=$|[\s|;&"'`)])/u.test(code);
}

/** A justfile line invokes rust tooling — cargo / rustc — as a whole-word
 * token. Mirrors {@link lineHasNodeToolingToken}. */
function lineHasRustToolingToken(line: string): boolean {
  const code = stripJustfileComment(line);
  return /(?:^|[\s|;&"'`(])(?:cargo|rustc)(?=$|[\s|;&"'`)])/u.test(code);
}
