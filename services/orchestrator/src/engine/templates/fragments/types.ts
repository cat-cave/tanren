// TEMPLATE-FRAGMENT TYPES — the foundation of the matrix-hit composition path
// (docs/roadmap/templating-system.md §FRAGMENTS / PR-A).
//
// WHY: apex v55-v59 spent 1-8h per run on scaffold work that is structurally the
// same boilerplate; pre-built composable FRAGMENTS + a deterministic COMPOSER
// assemble a VirtualFileSystem in seconds (modeled on BTS / create-better-t-stack).
//
// LOAD-BEARING CONSTRAINT: templates must NOT let users sidestep Tanren's opinions
// on green CI, strong test tie-ins, and functional demos. The `base/` fragment is
// ALWAYS injected and STRUCTURAL — fragments FILL hooks, never REPLACE base
// scaffolding. Post-processors throw LOUDLY on wholesale base overwrites.
//
// FAIL-LOUD by construction:
//   - Every TemplateConfig field is a CLOSED enum.
//   - VFS.write throws on collision; merges go through the typed surface
//     (`mergeJson` / `appendToJustfileTarget` / `addPackageJsonDep` / `addEnvVar`).
//   - `addEnvVar` is the ONE reconciled exception (task #148 v75 fix — see the
//     method's docstring). Every other conflict throws.
//   - Corrupted VFS is caught by the composer's post-process assertions.

import { createHash } from "node:crypto";
import { z } from "zod";

// ---- Matrix point labels ---------------------------------------------------
//
// Each field of `TemplateConfig` is an OPEN string naming the fragment to apply
// for that phase slot (`runtime: "node-pnpm"` → fragment id `runtime-node-pnpm`).
// Open, not closed, because org-authored fragments (F2) extend the library at
// runtime: `selectFragmentConfig` reports any unresolvable id as missing-fragments,
// and the composer's `library.require(id)` is the final fail-loud line.

export const RuntimeId = z.string().min(1);
export type RuntimeId = z.infer<typeof RuntimeId>;
export const FrontendId = z.string().min(1);
export type FrontendId = z.infer<typeof FrontendId>;
export const BackendId = z.string().min(1);
export type BackendId = z.infer<typeof BackendId>;
export const DbId = z.string().min(1);
export type DbId = z.infer<typeof DbId>;
export const AuthId = z.string().min(1);
export type AuthId = z.infer<typeof AuthId>;
export const DeployId = z.string().min(1);
export type DeployId = z.infer<typeof DeployId>;
export const AddonId = z.string().min(1);
export type AddonId = z.infer<typeof AddonId>;
export const ExampleId = z.string().min(1);
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
 * The in-memory representation of a composed template. Fragments call into the
 * typed MUTATION surface (`write`, `mergeJson`, `appendToJustfileTarget`, …)
 * rather than stamping arbitrary strings.
 *
 * DETERMINISM: `toFlatMap` returns entries sorted by path; `hash` SHA-256s over
 * that sorted projection — two compose runs over the same config + fragment
 * library yield byte-identical hashes.
 */
export class VirtualFileSystem {
  // The raw file tree. Methods below are the ONLY supported mutation surface —
  // direct mutation bypasses the merge contracts + is a bug.
  readonly #files = new Map<string, string>();
  // Just-target hook lines collected by `appendToJustfileTarget`. `processJustfile`
  // splices these into the base/ justfile before the VFS finalizes.
  readonly #justHooks = new Map<string, string[]>();
  // Env declarations (key → example) — emitted as `.env.example` by `processEnvVars`.
  // Same key + DIFFERENT example RECONCILES (task #148 v75 fix): later wins + the
  // conflict is appended to `#envReconciliations`. Idempotent same-example is a no-op.
  readonly #envVars = new Map<string, string>();
  // Reconciliation trail — `compose.ts` reads this per-fragment (before/after slice
  // around `fragment.apply`) and emits a warn log naming both origins.
  readonly #envReconciliations: EnvReconciliation[] = [];
  // Origin attribution — populated by `addEnvVar` when the composer set
  // `#currentFragmentId` via `beginFragment(id)`. Absent for isolated-apply callers.
  readonly #envDeclaringFragment = new Map<string, string>();
  #currentFragmentId: string | undefined;
  // package.json deps (name → version) — `processDeps` merges + dedupes + sorts
  // before writing the final package.json. Conflicting version throws.
  readonly #pkgDeps = new Map<string, string>();
  readonly #pkgDevDeps = new Map<string, string>();

  /** Write a brand-new file. Throws on collision — use `overwrite` or the typed
   * merge methods for structured content. */
  write(path: string, content: string): void {
    if (this.#files.has(path)) {
      throw new VfsCollisionError(path);
    }
    this.#files.set(path, content);
  }

  /** Overwrite a file the caller owns (fragment re-emit, or post-processor
   * writing the final justfile/env/etc). `write` is the default. */
  overwrite(path: string, content: string): void {
    this.#files.set(path, content);
  }

  /** Remove a path. `assertBaseInvariantsHeld` re-checks `BASE_PROTECTED_FILES`
   * post-compose and throws on a missing one — fragments must not delete those. */
  delete(path: string): boolean {
    return this.#files.delete(path);
  }

  /** True iff the path is present. Fragments should NOT branch on this —
   * `dependsOn` is the explicit ordering contract. */
  has(path: string): boolean {
    return this.#files.has(path);
  }

  /** Read a file's content. Throws when absent (absent-vs-empty distinction is
   * load-bearing for the post-processors). */
  read(path: string): string {
    const content = this.#files.get(path);
    if (content === undefined) {
      throw new Error(`VirtualFileSystem.read: ${path} is not present`);
    }
    return content;
  }

  /** Merge a json file with a caller-supplied merger. Receives parsed JSON (or
   * `{}` when absent); VFS re-serializes with two-space indent + trailing newline.
   * Parse failure throws LOUDLY. */
  mergeJson(path: string, merger: (current: Record<string, unknown>) => Record<string, unknown>): void {
    const current = this.#files.has(path) ? this.#parseJsonOrThrow(path) : {};
    const merged = merger(current);
    this.#files.set(path, `${JSON.stringify(merged, null, 2)}\n`);
  }

  /** Append lines to a justfile target's hook list. base/ owns the recipe
   * structure; a fragment fills the body via this (never re-writes the justfile).
   * `processJustfile` throws LOUDLY on an unknown target. */
  appendToJustfileTarget(target: string, lines: string[]): void {
    const existing = this.#justHooks.get(target) ?? [];
    existing.push(...lines);
    this.#justHooks.set(target, existing);
  }

  /** Register a runtime dep. A second declaration of the SAME dep with a
   * different version throws — version pinning must be reconciled at authoring
   * time, not via a silent "last writer wins" race. */
  addPackageJsonDep(name: string, version: string): void {
    this.#registerDep(this.#pkgDeps, "dependencies", name, version);
  }

  /** Same as `addPackageJsonDep` for devDependencies. */
  addPackageJsonDevDep(name: string, version: string): void {
    this.#registerDep(this.#pkgDevDeps, "devDependencies", name, version);
  }

  /**
   * Register an env var (e.g. `DATABASE_URL`). `processEnvVars` collects these
   * into `.env.example`.
   *
   * CONFLICT POLICY (task #148 apex v75 fix): idempotent same-example is a
   * no-op; same key with DIFFERENT example → LATER wins + a record is appended
   * to `#envReconciliations`, and the composer emits a per-fragment warn log
   * naming both fragments. Replaces throw-on-conflict which halted compose
   * before the writer loop could ever repair it — the db-* / deploy-* / notify-*
   * fragments own the shape of their URL/token, so later-wins is the correct
   * default. The writer prompt (providerFragmentAuthorer.ts) also names those
   * keys as OWNED so a JIT-authored runtime stops declaring them.
   */
  addEnvVar(key: string, exampleValue: string): void {
    const existing = this.#envVars.get(key);
    if (existing !== undefined && existing !== exampleValue) {
      this.#envReconciliations.push({
        key,
        previousExample: existing,
        previousDeclaringFragment: this.#envDeclaringFragment.get(key),
        currentExample: exampleValue,
        currentDeclaringFragment: this.#currentFragmentId,
      });
    }
    this.#envVars.set(key, exampleValue);
    if (this.#currentFragmentId !== undefined) {
      this.#envDeclaringFragment.set(key, this.#currentFragmentId);
    }
  }

  /** OPTIONAL attribution seam (task #148) — the composer's `applyPhase` wraps
   * each `fragment.apply` in `beginFragment(id)` / `endFragment()` so
   * reconciliations carry the winner id + the warn log names both origins.
   * Never nested (one fragment at a time); tests may skip. */
  beginFragment(fragmentId: string): void {
    this.#currentFragmentId = fragmentId;
  }

  endFragment(): void {
    this.#currentFragmentId = undefined;
  }

  /** The trail of env-var conflicts the composer reconciled by later-wins. Empty
   * when every `addEnvVar` call was either the first for its key or an idempotent
   * same-example repeat. */
  envReconciliations(): readonly EnvReconciliation[] {
    return this.#envReconciliations;
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

/** A single env-var conflict the VFS reconciled by later-wins (task #148 apex
 * v75 fix). Origin ids may be `undefined` when the caller skipped
 * `beginFragment(id)` attribution — the example pair is still recorded. */
export interface EnvReconciliation {
  readonly key: string;
  readonly previousExample: string;
  readonly previousDeclaringFragment: string | undefined;
  readonly currentExample: string;
  readonly currentDeclaringFragment: string | undefined;
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
