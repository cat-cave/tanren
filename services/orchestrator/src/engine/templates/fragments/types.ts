// TEMPLATE-FRAGMENT TYPES — the foundation of the matrix-hit composition path
// (docs/roadmap/templating-system.md §FRAGMENTS / PR-A).
//
// WHY: today every project DAG seeds from a freshly AUTHORED scaffold spec (the agent
// path). apex v55-v59 spent 1-8h per run on scaffold work that is structurally the
// same boilerplate. This module is the foundation of the matrix-hit alternative —
// pre-built composable FRAGMENTS that a deterministic COMPOSER assembles into a
// VirtualFileSystem in seconds, modeled on BTS (create-better-t-stack).
//
// THE LOAD-BEARING CONSTRAINT (user): "Just because we want to take advantage of
// templates does not mean we want to allow users to sidestep all of the things that
// Tanren is opinionated on, like green CI, strong behavior tie-ins to tests, and
// functional demos." The `base/` fragment is ALWAYS injected and STRUCTURAL —
// fragments FILL hooks, never REPLACE base scaffolding. Compose-time post-processors
// throw LOUDLY on any attempt to overwrite a base target wholesale (see
// compose.ts § processJustfile).
//
// FAIL-LOUD by construction:
//   - Every TemplateConfig field is a CLOSED enum (a typo cannot silently widen).
//   - VFS.write throws on a re-write that collides; merges go through the explicit
//     `mergeJson` / `appendToJustfileTarget` / `addPackageJsonDep` / `addEnvVar`
//     surface so the intent is named (no "last writer wins" silent overwrites).
//   - Fragment apply() returning a corrupted VFS is caught by the composer's
//     post-process assertions (compose.ts) — never a silent half-built tree.
//
// AGENT FALLBACK: a TemplateConfig the registry does NOT carry triggers the existing
// agent template-build child path (no change in this PR). The matrix-hit/miss split is
// PR-C; this module is the foundation.

import { createHash } from "node:crypto";
import { z } from "zod";

// ---- Matrix point enums ----------------------------------------------------

// Each field of `TemplateConfig` is a CLOSED zod enum: a matrix point is a tuple of
// these values, and a typo at the call site is a parse error, not a silent miss.
// Adding a new point is an enum addition + a new fragment under `library/` + a snapshot
// update — the dogfood test FORCES the snapshot update PR (the review unit).

export const RuntimeId = z.enum(["node-pnpm", "ruby-bundler"]);
export type RuntimeId = z.infer<typeof RuntimeId>;

export const FrontendId = z.enum(["react-router"]);
export type FrontendId = z.infer<typeof FrontendId>;

export const BackendId = z.enum(["hono"]);
export type BackendId = z.infer<typeof BackendId>;

export const DbId = z.enum(["postgres-prisma"]);
export type DbId = z.infer<typeof DbId>;

export const AuthId = z.enum(["better-auth"]);
export type AuthId = z.infer<typeof AuthId>;

export const DeployId = z.enum(["fly", "vercel", "none"]);
export type DeployId = z.infer<typeof DeployId>;

export const AddonId = z.enum(["biome", "docker"]);
export type AddonId = z.infer<typeof AddonId>;

export const ExampleId = z.enum(["todo", "ai"]);
export type ExampleId = z.infer<typeof ExampleId>;

// ---- TemplateConfig --------------------------------------------------------

/**
 * A matrix-point identity. `slug` is the human label for this config (used as the
 * snapshot file stem + the registry key); every other field is a closed enum.
 *
 * A field set to `undefined` means "this phase is OMITTED" — the composer skips it.
 * A `frontend: undefined` config composes a back-end-only template; a `db: undefined`
 * composes a no-database template; etc. `deploy` is REQUIRED (every Tanren project
 * declares a deploy verb — `deploy: "none"` is the explicit no-deploy marker, not an
 * absent key).
 */
export const TemplateConfig = z
  .object({
    slug: z.string().min(1),
    runtime: RuntimeId,
    frontend: FrontendId.optional(),
    backend: BackendId.optional(),
    db: DbId.optional(),
    auth: AuthId.optional(),
    deploy: DeployId,
    addons: z.array(AddonId).default([]),
    examples: z.array(ExampleId).default([]),
  })
  .strict();
export type TemplateConfig = z.infer<typeof TemplateConfig>;

// ---- Virtual file system ---------------------------------------------------

/**
 * The in-memory representation of a composed template. Fragments call into the typed
 * MUTATION surface (`write`, `mergeJson`, `appendToJustfileTarget`, …) rather than
 * stamping arbitrary strings — the named methods make the merge intent explicit and
 * give the post-processors deterministic hooks to assemble final files (the justfile,
 * `.tanren/ci.yml`, `.env.example`, `package.json` deps).
 *
 * DETERMINISM: `toFlatMap` returns entries sorted by path; `hash` SHA-256s over that
 * sorted projection. Two compose runs over the same config + fragment library yield
 * byte-identical hashes (the dogfood snapshot invariant).
 */
export class VirtualFileSystem {
  // The raw file tree. Methods below are the ONLY supported mutation surface — direct
  // mutation by a caller bypasses the merge contracts (deps dedupe, justfile
  // hook-fill, env collection) and is treated as a bug.
  readonly #files = new Map<string, string>();
  // Just-target hook lines collected by `appendToJustfileTarget`. The base/ fragment's
  // justfile names the targets; runtime/frontend/etc fragments fill HOOK INSERTION
  // POINTS via this map; `processJustfile` (compose.ts) splices them in before the
  // VFS finalizes. Keyed by target name (`bootstrap`/`tier-1`/`tier-2`/`tier-3`/`build`).
  readonly #justHooks = new Map<string, string[]>();
  // Collected env declarations (key → example value) — emitted as `.env.example` by
  // `processEnvVars`. A second declaration of the same key with a DIFFERENT example
  // throws (a fragment lying about a shared key's example value is a bug).
  readonly #envVars = new Map<string, string>();
  // Collected package.json deps (name → version). Runtime fragments seed the
  // base package.json; downstream fragments add deps via this map; `processDeps`
  // merges + dedupes + sorts before writing the final package.json. A conflicting
  // version range for the same dep throws.
  readonly #pkgDeps = new Map<string, string>();
  // Same shape for devDependencies.
  readonly #pkgDevDeps = new Map<string, string>();

  /**
   * Write a brand-new file. Throws on collision — overwriting a file is ALWAYS a bug
   * (a fragment racing the base, or two fragments declaring the same path). To merge
   * structured content (json, justfile, env), use the typed merge methods below.
   */
  write(path: string, content: string): void {
    if (this.#files.has(path)) {
      throw new VfsCollisionError(path);
    }
    this.#files.set(path, content);
  }

  /**
   * Overwrite a file the CALLER owns (a fragment re-emitting its own file after a
   * mutation, or the composer's post-processors writing the final justfile/env/etc).
   * Use sparingly — `write` is the default; this is the explicit override marker.
   */
  overwrite(path: string, content: string): void {
    this.#files.set(path, content);
  }

  /**
   * Remove a path. Returns true if the path was present, false otherwise. Fragments
   * SHOULD NOT use this on base-owned files — the composer's `assertBaseInvariantsHeld`
   * re-checks `BASE_PROTECTED_FILES` post-compose and throws on a missing one.
   */
  delete(path: string): boolean {
    return this.#files.delete(path);
  }

  /**
   * True iff the path is currently in the VFS. Tests + post-processors read this; a
   * fragment SHOULD NOT branch on it (the dependency model is `dependsOn`, not the
   * file-presence side-channel — `dependsOn` is the explicit, ordered contract).
   */
  has(path: string): boolean {
    return this.#files.has(path);
  }

  /**
   * Read a file's content. Throws when absent — the absent-vs-empty distinction is
   * load-bearing for the post-processors, so a silent `""` fallback would mask a
   * fragment-ordering bug.
   */
  read(path: string): string {
    const content = this.#files.get(path);
    if (content === undefined) {
      throw new Error(`VirtualFileSystem.read: ${path} is not present`);
    }
    return content;
  }

  /**
   * Merge a json file with a caller-supplied merger. The merger receives the parsed
   * JSON (or `{}` when the file does not yet exist) and returns the merged value; the
   * VFS re-serializes with two-space indent + trailing newline (a deterministic shape
   * the snapshot can compare against). A parse failure throws LOUDLY — a malformed
   * json file from an earlier fragment is a bug, not something to absorb.
   */
  mergeJson(path: string, merger: (current: Record<string, unknown>) => Record<string, unknown>): void {
    const current = this.#files.has(path) ? this.#parseJsonOrThrow(path) : {};
    const merged = merger(current);
    this.#files.set(path, `${JSON.stringify(merged, null, 2)}\n`);
  }

  /**
   * Append one or more lines to a justfile TARGET's hook list. The base/ fragment owns
   * the justfile RECIPE structure (the target names + insertion-point markers); a
   * runtime/etc fragment fills the recipe body by calling this — never by re-writing
   * the justfile. `processJustfile` assembles the final file. A target name not
   * recognized by `processJustfile` is a LOUD failure at compose time (the writer
   * mis-named the hook).
   */
  appendToJustfileTarget(target: string, lines: string[]): void {
    const existing = this.#justHooks.get(target) ?? [];
    existing.push(...lines);
    this.#justHooks.set(target, existing);
  }

  /**
   * Register a runtime dependency a fragment requires. A second declaration of the
   * SAME dep with a different version throws — version pinning across fragments must
   * be reconciled at AUTHORING time, not via a silent "last writer wins" race.
   */
  addPackageJsonDep(name: string, version: string): void {
    this.#registerDep(this.#pkgDeps, "dependencies", name, version);
  }

  /**
   * Register a devDependency. Same conflict policy as `addPackageJsonDep`.
   */
  addPackageJsonDevDep(name: string, version: string): void {
    this.#registerDep(this.#pkgDevDeps, "devDependencies", name, version);
  }

  /**
   * Register an env var the runtime needs (e.g. `DATABASE_URL`). `processEnvVars`
   * collects these into `.env.example`. A second declaration with a DIFFERENT example
   * throws (the example is the operator's first read of what the var is FOR; two
   * fragments disagreeing means a real coordination bug).
   */
  addEnvVar(key: string, exampleValue: string): void {
    const existing = this.#envVars.get(key);
    if (existing !== undefined && existing !== exampleValue) {
      throw new Error(
        `VirtualFileSystem.addEnvVar: ${key} declared twice with conflicting examples ` +
          `(${JSON.stringify(existing)} vs ${JSON.stringify(exampleValue)})`,
      );
    }
    this.#envVars.set(key, exampleValue);
  }

  /**
   * Snapshot of the just-target hook lines collected by fragments. Read by
   * `processJustfile` to splice fragment fills into base targets.
   */
  justHookLines(target: string): readonly string[] {
    return this.#justHooks.get(target) ?? [];
  }

  /**
   * Every just-target a fragment has filled. Used by `processJustfile` to detect a
   * hook fill against an UNKNOWN target (a writer typo) — every key here must be in
   * the base/ fragment's declared hook set.
   */
  justHookTargets(): readonly string[] {
    return Array.from(this.#justHooks.keys()).sort();
  }

  /** Collected runtime dependencies (name → version). */
  collectedDeps(): ReadonlyMap<string, string> {
    return new Map(this.#pkgDeps);
  }

  /** Collected dev dependencies (name → version). */
  collectedDevDeps(): ReadonlyMap<string, string> {
    return new Map(this.#pkgDevDeps);
  }

  /** Collected env vars (key → example). */
  collectedEnvVars(): ReadonlyMap<string, string> {
    return new Map(this.#envVars);
  }

  /**
   * Path → content, sorted by path. This is the canonical serialization the dogfood
   * snapshot compares against; the sort key makes two compose runs hash-identical.
   */
  toFlatMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Array.from(this.#files.keys()).sort()) {
      const value = this.#files.get(key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  /**
   * SHA-256 over the sorted flat-map (path\0content joined by \n). Deterministic — a
   * fragment change forces a snapshot diff, and an unrelated reordering does NOT.
   */
  hash(): string {
    const flat = this.toFlatMap();
    const hasher = createHash("sha256");
    for (const path of Object.keys(flat)) {
      hasher.update(path);
      hasher.update("\0");
      hasher.update(flat[path] ?? "");
      hasher.update("\n");
    }
    return hasher.digest("hex");
  }

  #parseJsonOrThrow(path: string): Record<string, unknown> {
    const raw = this.#files.get(path) ?? "";
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`expected an object at the top level, got ${typeof parsed}`);
      }
      return parsed as Record<string, unknown>;
    } catch (cause) {
      throw new Error(`VirtualFileSystem.mergeJson: ${path} is not valid JSON (${String(cause)})`, { cause });
    }
  }

  #registerDep(map: Map<string, string>, label: string, name: string, version: string): void {
    const existing = map.get(name);
    if (existing !== undefined && existing !== version) {
      throw new Error(
        `VirtualFileSystem.add${label === "dependencies" ? "PackageJsonDep" : "PackageJsonDevDep"}: ` +
          `${name} declared twice with conflicting versions (${existing} vs ${version})`,
      );
    }
    map.set(name, version);
  }
}

/** Thrown by `VirtualFileSystem.write` on a colliding path. Distinct class so the
 * composer's error envelope can attribute the throw to a specific fragment. */
export class VfsCollisionError extends Error {
  constructor(readonly path: string) {
    super(`VirtualFileSystem.write: ${path} already present (use a typed merge or overwrite)`);
    this.name = "VfsCollisionError";
  }
}

// ---- Fragment shape --------------------------------------------------------

/**
 * The 9 phases of `composeTemplate` (compose.ts). A fragment declares its `kind`, the
 * composer routes it to the matching phase, and the post-processors run after every
 * fragment apply. Each phase has a single semantic role; the ordering is load-bearing
 * (a `db` fragment cannot assume a runtime exists until the runtime phase has run).
 */
export const FragmentKind = z.enum([
  "base",
  "runtime",
  "frontend",
  "backend",
  "db",
  "auth",
  "addon",
  "example",
  "deploy",
]);
export type FragmentKind = z.infer<typeof FragmentKind>;

/** Opaque fragment id (kind + a stable label). Used as the dependency-graph key and
 * as the dogfood snapshot's `fragmentVersions` key. */
export type FragmentId = string;

/**
 * What a fragment PROVIDES to downstream phases + post-processors. The composer never
 * INFERS these — a fragment must declare them, so a runtime swap (node-pnpm →
 * ruby-bundler) makes the downstream wiring (the ci.yml evidence declaration's test
 * runner, the db migration directory) explicit.
 *
 * Every field is OPTIONAL — a fragment may declare none (an addon that ships only
 * tooling config), one, or many. The post-processors read each field; a missing
 * required field (e.g. no fragment declared a `testRunner` for processCiYml) throws
 * LOUDLY at compose time so the misconfiguration cannot ship.
 */
export interface FragmentContract {
  /** The test runner the runtime fragment installed (e.g. `"vitest"`, `"rspec"`). */
  testRunner?: string;
  /** The workspace-relative path the test runner writes a JUnit report to (the
   * `processCiYml` post-processor uses this to fill the evidence block on tier-2+). */
  reportPath?: string;
  /** The workspace-relative path the db migration directory lives at (read by the
   * deploy fragment + addons that need to wire migration commands). */
  dbMigrationsDir?: string;
  /** The shell command for the tier-2 gate (test run). Filled into the justfile's
   * tier-2 target by `appendToJustfileTarget`; declared HERE so the post-processor
   * can sanity-check the runtime's declaration vs the justfile fill. */
  ciTier2?: string;
}

/**
 * A composable fragment. `apply()` mutates a VFS in place; `dependsOn` declares the
 * other fragments that must have applied first (used by the library's dependency
 * resolver). `version` rides on the dogfood snapshot's `fragmentVersions` map so a
 * fragment body bump (without a snapshot update) is caught by the snapshot diff.
 */
export interface Fragment {
  id: FragmentId;
  version: string;
  kind: FragmentKind;
  contract: FragmentContract;
  /** Other fragments this one requires. The composer resolves the order: a fragment
   * is applied only after every dependency has applied within its phase. A missing
   * dependency throws at registry-load time. */
  dependsOn?: readonly FragmentId[];
  apply(vfs: VirtualFileSystem, config: TemplateConfig): Promise<void>;
}

// ---- Library registry ------------------------------------------------------

/**
 * A typed Map<FragmentId, Fragment>. `register` throws on a duplicate id (a copy-paste
 * bug); `require` throws on a missing id (a config asking for a fragment that was not
 * registered — the matrix-miss case the agent fallback handles separately). The
 * BASE fragment is REQUIRED by compose — `loadFragmentLibrary` registers it
 * unconditionally.
 */
export class FragmentLibrary {
  readonly #fragments = new Map<FragmentId, Fragment>();

  register(fragment: Fragment): void {
    if (this.#fragments.has(fragment.id)) {
      throw new Error(`FragmentLibrary.register: duplicate fragment id "${fragment.id}"`);
    }
    this.#fragments.set(fragment.id, fragment);
  }

  /** Test-only seam: replace a fragment's body (e.g. inject a misbehaving variant for
   * an enforcement test). Throws when the id is not present — register first. */
  replaceForTests(fragment: Fragment): void {
    if (!this.#fragments.has(fragment.id)) {
      throw new Error(`FragmentLibrary.replaceForTests: ${fragment.id} not registered`);
    }
    this.#fragments.set(fragment.id, fragment);
  }

  has(id: FragmentId): boolean {
    return this.#fragments.has(id);
  }

  require(id: FragmentId): Fragment {
    const fragment = this.#fragments.get(id);
    if (fragment === undefined) {
      throw new Error(`FragmentLibrary.require: no fragment registered for id "${id}"`);
    }
    return fragment;
  }

  /** Every registered fragment, in stable id order. The dogfood test reads this. */
  all(): readonly Fragment[] {
    return Array.from(this.#fragments.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Every registered fragment of a given kind, in stable id order. */
  ofKind(kind: FragmentKind): readonly Fragment[] {
    return this.all().filter((f) => f.kind === kind);
  }

  /**
   * Resolve the apply ORDER for a set of fragments within a phase: a fragment is
   * placed after every dependency it declares. Throws on an unresolved dependency or
   * a cycle (a fragment depending on a non-registered id, or two fragments depending
   * on each other). Within an unconstrained group, sort by id for determinism.
   */
  resolveOrder(fragments: readonly Fragment[]): Fragment[] {
    const byId = new Map(fragments.map((f) => [f.id, f] as const));
    const visited = new Set<FragmentId>();
    const visiting = new Set<FragmentId>();
    const out: Fragment[] = [];
    const sorted = [...fragments].sort((a, b) => a.id.localeCompare(b.id));
    const visit = (fragment: Fragment): void => {
      if (visited.has(fragment.id)) return;
      if (visiting.has(fragment.id)) {
        throw new Error(`FragmentLibrary.resolveOrder: dependency cycle through "${fragment.id}"`);
      }
      visiting.add(fragment.id);
      for (const depId of fragment.dependsOn ?? []) {
        const dep = byId.get(depId) ?? this.#fragments.get(depId);
        if (dep === undefined) {
          throw new Error(`FragmentLibrary.resolveOrder: "${fragment.id}" depends on missing "${depId}"`);
        }
        if (byId.has(depId)) visit(dep);
      }
      visiting.delete(fragment.id);
      visited.add(fragment.id);
      out.push(fragment);
    };
    for (const fragment of sorted) visit(fragment);
    return out;
  }
}
