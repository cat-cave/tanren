// UNIFIED FRAGMENT LIBRARY — bundled core + org-scoped (docs/roadmap/
// templating-system.md, F2).
//
// `loadUnifiedFragmentLibrary(orgId, deps)` returns a SINGLE `FragmentLibrary`
// that combines:
//   1. The bundled core fragments from `library/index.ts` (always present;
//      evolved via tanren-monorepo PRs).
//   2. The org-scoped fragments persisted by the per-fragment authoring DAG into
//      the `fragments` table. Loaded via the injected `loadOrgFragments` seam (so
//      this module keeps no DB dependency — the wiring layer injects it).
//
// SHADOWING. When an org-scoped fragment has the SAME `(kind, label)` as a
// bundled core fragment, the org-scoped fragment WINS. This is not a fallback —
// it is the doctrine: organizations may override Tanren's defaults; if they
// don't, they get the core. The bundled fragment is replaced via
// `library.replaceForTests` (the existing test-only seam — re-purposed; the
// override is a first-class behavior, not a test-only path).

import { loadFragmentLibrary as loadBundledLibrary } from "./library/index.js";
import { FragmentContractSchema, type FragmentContractShape } from "../../repositories/fragments.js";
import {
  assertOnlyVfsStatements,
  extractApplyBody,
  findMatchingClose,
  FragmentBodyParseError,
} from "./fragmentBodyWalker.js";
import {
  type Fragment,
  FragmentKind,
  type FragmentLibrary,
  type TemplateConfig,
  type VirtualFileSystem,
} from "./types.js";

// Re-export the parser-error class so existing consumers (index.ts +
// downstream tests / adapters) keep importing it from unifiedLibrary. The
// balanced-brace walker owns the class internally so it can throw it without
// a circular import.
export { FragmentBodyParseError };

/** A serialized org-scoped fragment as it lives in the `fragments` table — pure
 * data, no executable. The unified library loader turns this into a real
 * `Fragment` by dynamically interpreting `bodyTs`. */
export interface OrgFragmentSource {
  /** Stable id: `<orgId>:<kind>-<label>:<version>`. */
  fragmentId: string;
  kind: string;
  label: string;
  version: string;
  /** The fragment's TS source — a default-exported `Fragment` object. */
  bodyTs: string;
  contract: FragmentContractShape;
  dependsOn: readonly string[];
}

/** The wiring-layer seam: read the latest validated fragments for an org. */
export type LoadOrgFragments = (orgId: string) => Promise<readonly OrgFragmentSource[]>;

/** Build the unified library for an org. When `loadOrgFragments` is undefined or
 * returns an empty list, the result is the bundled core verbatim — no shadowing
 * occurs, just the defaults. */
export async function loadUnifiedFragmentLibrary(
  orgId: string | undefined,
  loadOrgFragments?: LoadOrgFragments,
): Promise<FragmentLibrary> {
  const library = loadBundledLibrary();
  if (orgId === undefined || loadOrgFragments === undefined) return library;

  const orgFragments = await loadOrgFragments(orgId);
  for (const source of orgFragments) {
    const fragment = interpretOrgFragment(source);
    if (library.has(fragment.id)) {
      // SHADOW the bundled fragment — the org's authored version wins.
      library.replaceForTests(fragment);
    } else {
      library.register(fragment);
    }
  }
  return library;
}

/**
 * Convert a persisted org fragment row into a runnable `Fragment`. The `bodyTs`
 * field holds the fragment's TypeScript source — a module that default-exports
 * the `Fragment` object. We do NOT eval the body at load time: instead we
 * construct a synthetic `Fragment` whose `apply()` interprets the body's
 * DECLARATIVE INSTRUCTIONS (a constrained subset — `vfs.write`,
 * `vfs.addPackageJsonDep`, etc — extracted by a tiny parser).
 *
 * Why a constrained interpreter instead of `new Function(bodyTs)`: an authored
 * fragment runs untrusted code in the orchestrator process; eval would give a
 * compromised authoring run arbitrary code execution. The constrained subset is
 * intentionally narrow — only the typed mutation surface fragments need — and
 * a body that calls anything outside the subset fails to parse at registration
 * time (the F2 validator gates on that).
 */
export function interpretOrgFragment(source: OrgFragmentSource): Fragment {
  const kind = FragmentKind.parse(source.kind);
  const contract = FragmentContractSchema.parse(source.contract);
  const id = `${kind}-${source.label}`;
  const ops = parseFragmentBody(source.bodyTs);
  return {
    id,
    version: source.version,
    kind,
    contract,
    ...(source.dependsOn.length > 0 ? { dependsOn: [...source.dependsOn] } : {}),
    async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
      for (const op of ops) {
        applyOp(vfs, op);
      }
    },
  };
}

// ── Constrained body parser ─────────────────────────────────────────────────

/**
 * A constrained subset of the typed mutation surface fragments may declare. The
 * parser extracts these from the body's `apply()` block; any other shape rejects.
 *
 * Supported declarations (each ONE line, semicolons optional):
 *   vfs.write("path", `content`);
 *   vfs.overwrite("path", `content`);
 *   vfs.addPackageJsonDep("name", "version");
 *   vfs.addPackageJsonDevDep("name", "version");
 *   vfs.addEnvVar("KEY", "exampleValue");
 *   vfs.appendToJustfileTarget("target", ["line1", "line2"]);
 *
 * The authoring DAG's writer emits this exact shape — the validate stage runs
 * PR-D's isolation test against the parsed fragment to prove it composes.
 */
/** The constrained-subset operations a fragment body may declare. Exported so
 * the fragment-authoring smoke validator can derive an IMPLICIT `dependsOn` from
 * the parsed ops (audit finding #11 — any `addPackageJsonDep` /
 * `addPackageJsonDevDep` call ⇒ implicit `runtime-node-pnpm` dependency). */
export type FragmentOp =
  | { kind: "write"; path: string; content: string }
  | { kind: "overwrite"; path: string; content: string }
  | { kind: "dep"; name: string; version: string }
  | { kind: "devDep"; name: string; version: string }
  | { kind: "env"; key: string; example: string }
  | { kind: "just"; target: string; lines: string[] };

const STRING_LITERAL_PATTERN = /^"((?:[^"\\]|\\.)*)"$|^`((?:[^`\\]|\\.)*)`$/u;

function parseStringLiteral(token: string): string {
  const t = token.trim();
  const m = STRING_LITERAL_PATTERN.exec(t);
  if (m === null) {
    throw new FragmentBodyParseError(
      `expected a string literal (double-quoted "..." or backtick \`...\`), got ${truncateForError(t)}. ` +
        `Only literal strings are accepted as arguments — no string concatenation, template interpolation, ` +
        `or identifiers. Example: vfs.write("docs/hello.md", "content"). To include a variable value, ` +
        `bake it into the literal at authoring time.`,
    );
  }
  // Group 1 = double-quoted; group 2 = backtick. Unescape the obvious common escapes.
  const raw = m[1] ?? m[2] ?? "";
  return raw.replaceAll('\\"', '"').replaceAll("\\`", "`").replaceAll("\\n", "\n").replaceAll("\\\\", "\\");
}

/** Truncate a token for inclusion in an error message so a huge template
 * literal doesn't drown out the actual guidance. */
function truncateForError(t: string): string {
  const MAX = 80;
  return t.length <= MAX ? t : `${t.slice(0, MAX)}…(${t.length - MAX} more chars)`;
}

function parseArrayOfStrings(token: string): string[] {
  const t = token.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) {
    throw new FragmentBodyParseError(
      `expected an array literal of string literals like ["line1", "line2"], got ${truncateForError(t)}. ` +
        `Example: vfs.appendToJustfileTarget("bootstrap", ["pnpm install --frozen-lockfile"]).`,
    );
  }
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  // Split on top-level commas (no nested arrays in this subset).
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  let inStr: '"' | "`" | undefined;
  for (const ch of inner) {
    if (inStr === undefined) {
      if (ch === '"' || ch === "`") inStr = ch;
      else if (ch === "[" || ch === "(") depth += 1;
      else if (ch === "]" || ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        parts.push(buf);
        buf = "";
        continue;
      }
    } else if (ch === inStr) {
      inStr = undefined;
    }
    buf += ch;
  }
  if (buf.trim() !== "") parts.push(buf);
  return parts.map((part) => parseStringLiteral(part));
}

/** Split a function-call arg list on top-level commas, respecting strings + brackets. */
function splitArgs(rawArgs: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let buf = "";
  let inStr: '"' | "`" | undefined;
  for (const ch of rawArgs) {
    if (inStr === undefined) {
      if (ch === '"' || ch === "`") inStr = ch;
      else if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      if (ch === "," && depth === 0) {
        args.push(buf);
        buf = "";
        continue;
      }
    } else if (ch === inStr) {
      inStr = undefined;
    }
    buf += ch;
  }
  if (buf.trim() !== "") args.push(buf);
  return args.map((a) => a.trim());
}

const CALL_PATTERN = /^vfs\.([a-zA-Z]+)\s*\(([\s\S]*)\)\s*;?$/u;

// NOTE: `extractApplyBody`, `findMatchingClose`, and `assertOnlyVfsStatements`
// used to live here. They are now in `fragmentBodyWalker.ts` so this module
// stays under the 500-line file cap. See that file's header for the balanced-
// brace / non-vfs-statement rejection rationale.

/** Parse a fragment body's `apply()` block into the constrained-subset `FragmentOp`
 * list. Exported so the fragment-authoring smoke validator can derive implicit
 * runtime dependencies from the ops (audit finding #11). Throws
 * `FragmentBodyParseError` on any unsupported call shape. */
export function parseFragmentBody(bodyTs: string): FragmentOp[] {
  // 1) Extract the body between the `apply()` block's outermost braces via a
  //    balanced-brace walker — nested `{}` inside string / template / comment
  //    literals do NOT truncate the body (fix for Claude HIGH #1).
  const body = extractApplyBody(bodyTs);
  // 2) Reject non-vfs statements up-front so the persisted TS source and the
  //    interpreted ops list can never disagree (fix for Codex #6). Comments and
  //    blank lines are allowed; anything else halts with a writer-facing
  //    rejection that names the offending prefix.
  assertOnlyVfsStatements(body);
  // 3) Walk the body a second time, collecting each `vfs.<method>(…)` call.
  //    `assertOnlyVfsStatements` has already proven every top-level unit is
  //    either a comment, whitespace, or a vfs call — so this loop's only job
  //    is to slice each call and hand it to `toOp`. Comment-stripping keeps
  //    the CALL_PATTERN regex simple.
  const stripped = body.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");
  const ops: FragmentOp[] = [];
  let i = 0;
  while (i < stripped.length) {
    const next = stripped.indexOf("vfs.", i);
    if (next === -1) break;
    let end = next + 4;
    while (end < stripped.length && stripped[end] !== "(") end += 1;
    if (end >= stripped.length) break;
    const openParen = end;
    const closeParen = findMatchingClose(stripped, openParen, "apply() body has unbalanced parens in a vfs.* call");
    const stmt = stripped.slice(next, closeParen + 1);
    const cm = CALL_PATTERN.exec(stmt);
    if (cm !== null) {
      const method = cm[1]!;
      const args = splitArgs(cm[2]!);
      ops.push(toOp(method, args));
    }
    i = closeParen + 1;
  }
  return ops;
}

/** The allowed constrained-subset ops — surfaced in rejection messages so the
 * writer sees the accepted vocabulary the first time a call falls outside it. */
const ALLOWED_OPS_LEGEND = [
  `  - vfs.write("path", "content")             — create a brand-new file`,
  `  - vfs.overwrite("path", "content")         — replace an existing file`,
  `  - vfs.addPackageJsonDep("name", "version") — register a runtime dep`,
  `  - vfs.addPackageJsonDevDep("name", "version") — register a dev dep`,
  `  - vfs.addEnvVar("KEY", "example-value")    — declare an env var`,
  `  - vfs.appendToJustfileTarget("target", ["line1", "line2"]) — fill a justfile hook`,
].join("\n");

/** Rejection helper: "vfs.${method} expects N args" with a concrete example
 * for that op — so the writer's next attempt sees the exact accepted shape,
 * not just an arg-count error. */
function argCountRejection(method: string, expected: number, got: number): FragmentBodyParseError {
  const examples: Record<string, string> = {
    write: `vfs.write("docs/hello.md", "# Hello\\n")`,
    overwrite: `vfs.overwrite("package.json", "{\\n  \\"name\\": \\"x\\"\\n}\\n")`,
    addPackageJsonDep: `vfs.addPackageJsonDep("react", "^19.0.0")`,
    addPackageJsonDevDep: `vfs.addPackageJsonDevDep("vitest", "^4.0.0")`,
    addEnvVar: `vfs.addEnvVar("DATABASE_URL", "postgres://user:pass@host/db")`,
    appendToJustfileTarget: `vfs.appendToJustfileTarget("bootstrap", ["pnpm install --frozen-lockfile"])`,
  };
  const example = examples[method] ?? `(no example for ${method})`;
  return new FragmentBodyParseError(
    `vfs.${method} expects ${expected} arg${expected === 1 ? "" : "s"}, got ${got}. Example: ${example}.`,
  );
}

function toOp(method: string, args: string[]): FragmentOp {
  switch (method) {
    case "write": {
      if (args.length !== 2) throw argCountRejection(method, 2, args.length);
      return { kind: "write", path: parseStringLiteral(args[0]!), content: parseStringLiteral(args[1]!) };
    }
    case "overwrite": {
      if (args.length !== 2) throw argCountRejection(method, 2, args.length);
      return { kind: "overwrite", path: parseStringLiteral(args[0]!), content: parseStringLiteral(args[1]!) };
    }
    case "addPackageJsonDep": {
      if (args.length !== 2) throw argCountRejection(method, 2, args.length);
      return { kind: "dep", name: parseStringLiteral(args[0]!), version: parseStringLiteral(args[1]!) };
    }
    case "addPackageJsonDevDep": {
      if (args.length !== 2) throw argCountRejection(method, 2, args.length);
      return { kind: "devDep", name: parseStringLiteral(args[0]!), version: parseStringLiteral(args[1]!) };
    }
    case "addEnvVar": {
      if (args.length !== 2) throw argCountRejection(method, 2, args.length);
      return { kind: "env", key: parseStringLiteral(args[0]!), example: parseStringLiteral(args[1]!) };
    }
    case "appendToJustfileTarget": {
      if (args.length !== 2) throw argCountRejection(method, 2, args.length);
      return { kind: "just", target: parseStringLiteral(args[0]!), lines: parseArrayOfStrings(args[1]!) };
    }
    default:
      throw new FragmentBodyParseError(
        `unsupported vfs operation: vfs.${method}(...). The constrained-subset parser accepts ONLY:\n` +
          `${ALLOWED_OPS_LEGEND}\n` +
          `To ${suggestReplacementFor(method)}, use one of the ops above. Anything else (fs.*, http.*, ` +
          `child_process, string interpolation, conditionals, loops) is rejected — the parser reads the ` +
          `\`apply()\` block statement-by-statement, one call per line, literal-string arguments only.`,
      );
  }
}

/** Best-effort hint for a rejected method name — points the writer at the
 * closest accepted alternative so the next attempt has direction, not just a
 * refusal. */
function suggestReplacementFor(method: string): string {
  const m = method.toLowerCase();
  if (m.includes("read") || m.includes("get") || m.includes("has") || m.includes("exists")) {
    return `read or branch on file presence (the parser does NOT support reads — bake the value into the literal at authoring time)`;
  }
  if (m.includes("delete") || m.includes("remove") || m.includes("rm")) {
    return `remove a file (not supported — use vfs.overwrite to replace instead)`;
  }
  if (m.includes("dep") || m.includes("package") || m.includes("install")) {
    return `register a dependency (use vfs.addPackageJsonDep or vfs.addPackageJsonDevDep)`;
  }
  if (m.includes("env") || m.includes("var")) {
    return `declare an env var (use vfs.addEnvVar)`;
  }
  if (m.includes("just") || m.includes("target") || m.includes("hook")) {
    return `fill a justfile hook (use vfs.appendToJustfileTarget)`;
  }
  if (m.includes("write") || m.includes("create") || m.includes("mkdir") || m.includes("touch")) {
    return `create or overwrite a file (use vfs.write or vfs.overwrite)`;
  }
  return `perform that side-effect`;
}

function applyOp(vfs: VirtualFileSystem, op: FragmentOp): void {
  switch (op.kind) {
    case "write":
      vfs.write(op.path, op.content);
      break;
    case "overwrite":
      vfs.overwrite(op.path, op.content);
      break;
    case "dep":
      vfs.addPackageJsonDep(op.name, op.version);
      break;
    case "devDep":
      vfs.addPackageJsonDevDep(op.name, op.version);
      break;
    case "env":
      vfs.addEnvVar(op.key, op.example);
      break;
    case "just":
      vfs.appendToJustfileTarget(op.target, op.lines);
      break;
  }
}
