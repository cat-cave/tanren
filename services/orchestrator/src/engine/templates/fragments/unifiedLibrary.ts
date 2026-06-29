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
  type Fragment,
  FragmentKind,
  type FragmentLibrary,
  type TemplateConfig,
  type VirtualFileSystem,
} from "./types.js";

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

export class FragmentBodyParseError extends Error {
  constructor(message: string) {
    super(`FragmentBody parse error: ${message}`);
    this.name = "FragmentBodyParseError";
  }
}

const STRING_LITERAL_PATTERN = /^"((?:[^"\\]|\\.)*)"$|^`((?:[^`\\]|\\.)*)`$/u;

function parseStringLiteral(token: string): string {
  const t = token.trim();
  const m = STRING_LITERAL_PATTERN.exec(t);
  if (m === null) throw new FragmentBodyParseError(`expected string literal, got ${t}`);
  // Group 1 = double-quoted; group 2 = backtick. Unescape the obvious common escapes.
  const raw = m[1] ?? m[2] ?? "";
  return raw.replaceAll('\\"', '"').replaceAll("\\`", "`").replaceAll("\\n", "\n").replaceAll("\\\\", "\\");
}

function parseArrayOfStrings(token: string): string[] {
  const t = token.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) {
    throw new FragmentBodyParseError(`expected array literal, got ${t}`);
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

/** Parse a fragment body's `apply()` block into the constrained-subset `FragmentOp`
 * list. Exported so the fragment-authoring smoke validator can derive implicit
 * runtime dependencies from the ops (audit finding #11). Throws
 * `FragmentBodyParseError` on any unsupported call shape. */
export function parseFragmentBody(bodyTs: string): FragmentOp[] {
  // The body MUST declare a recognizable `apply(...)` block — a body without one
  // is not a fragment module (rejects free-form strings the writer produced
  // outside the constrained subset). The signature may carry a return-type
  // annotation (e.g. `: Promise<void>`); the regex tolerates anything between
  // `)` and the opening `{`.
  const applyMatch = /apply\s*\([^)]*\)[^{]*\{([\s\S]*?)\}\s*,?\s*\}?\s*;?\s*(?:export\s+default)?[\s\S]*$/u.exec(
    bodyTs,
  );
  if (applyMatch === null) {
    throw new FragmentBodyParseError("body does not declare an `apply(vfs, config)` block");
  }
  const body = applyMatch[1] ?? "";
  // Strip block + line comments before splitting on statements.
  const stripped = body.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");
  // Split on `vfs.` boundary so multi-line template literals stay intact.
  const ops: FragmentOp[] = [];
  // A simple state machine: accumulate from the start of each `vfs.…(` until the
  // matching `)`, respecting nested parens + string literals.
  let i = 0;
  while (i < stripped.length) {
    const next = stripped.indexOf("vfs.", i);
    if (next === -1) break;
    let end = next + 4;
    while (end < stripped.length && stripped[end] !== "(") end += 1;
    if (end >= stripped.length) break;
    const openParen = end;
    let depth = 1;
    let cursor = openParen + 1;
    let inStr: '"' | "`" | undefined;
    while (cursor < stripped.length && depth > 0) {
      const ch = stripped[cursor];
      if (inStr === undefined) {
        if (ch === '"' || ch === "`") inStr = ch;
        else if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
      } else if (ch === inStr) {
        inStr = undefined;
      }
      cursor += 1;
    }
    const stmt = stripped.slice(next, cursor);
    const m = CALL_PATTERN.exec(stmt);
    if (m !== null) {
      const method = m[1]!;
      const args = splitArgs(m[2]!);
      ops.push(toOp(method, args));
    }
    i = cursor;
  }
  return ops;
}

function toOp(method: string, args: string[]): FragmentOp {
  switch (method) {
    case "write": {
      if (args.length !== 2) throw new FragmentBodyParseError(`vfs.write expects 2 args, got ${args.length}`);
      return { kind: "write", path: parseStringLiteral(args[0]!), content: parseStringLiteral(args[1]!) };
    }
    case "overwrite": {
      if (args.length !== 2) throw new FragmentBodyParseError(`vfs.overwrite expects 2 args, got ${args.length}`);
      return { kind: "overwrite", path: parseStringLiteral(args[0]!), content: parseStringLiteral(args[1]!) };
    }
    case "addPackageJsonDep": {
      if (args.length !== 2)
        throw new FragmentBodyParseError(`vfs.addPackageJsonDep expects 2 args, got ${args.length}`);
      return { kind: "dep", name: parseStringLiteral(args[0]!), version: parseStringLiteral(args[1]!) };
    }
    case "addPackageJsonDevDep": {
      if (args.length !== 2)
        throw new FragmentBodyParseError(`vfs.addPackageJsonDevDep expects 2 args, got ${args.length}`);
      return { kind: "devDep", name: parseStringLiteral(args[0]!), version: parseStringLiteral(args[1]!) };
    }
    case "addEnvVar": {
      if (args.length !== 2) throw new FragmentBodyParseError(`vfs.addEnvVar expects 2 args, got ${args.length}`);
      return { kind: "env", key: parseStringLiteral(args[0]!), example: parseStringLiteral(args[1]!) };
    }
    case "appendToJustfileTarget": {
      if (args.length !== 2)
        throw new FragmentBodyParseError(`vfs.appendToJustfileTarget expects 2 args, got ${args.length}`);
      return { kind: "just", target: parseStringLiteral(args[0]!), lines: parseArrayOfStrings(args[1]!) };
    }
    default:
      throw new FragmentBodyParseError(`unsupported vfs operation: vfs.${method}`);
  }
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
