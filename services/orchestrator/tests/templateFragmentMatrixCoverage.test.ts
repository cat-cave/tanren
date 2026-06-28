// FRAGMENT MATRIX-COVERAGE HARNESS (PR-D — `docs/roadmap/templating-system.md
// §FRAGMENTS). Complements `templateFragmentIsolation.test.ts` by composing the
// CROSS-PRODUCT — every plausible (runtime × frontend × backend × db × auth ×
// addons × deploy) combination the library carries — and asserting the same
// invariants on every output. A registry entry that fails on one combination
// cannot ship; the matrix is the catch.
//
// THE MATRIX IS DERIVED FROM THE LIBRARY — `loadFragmentLibrary()` enumerates the
// registered fragments per kind, the cross-product is the test surface. A new
// fragment is picked up automatically; a stack-incompatible pair must be documented
// in `INCOMPATIBLE_COMBINATIONS` (never silently).
//
// PER-COMBINATION ASSERTIONS:
//   1. `composeTemplate` returns a `VirtualFileSystem` (no throw).
//   2. Every path in `BASE_PROTECTED_FILES` survives.
//   3. `.tanren/ci.yml` had its `__TANREN_REPORT_PATH__` token substituted.
//   4. A mutation-testing config is present (stryker.conf.mjs on node, .mutant.yml on ruby).
//   5. `package.json` coherence on the node-pnpm path (or principled absence on ruby).
//   6. Every declared env var landed in `.env.example`.
//   7. The composed `.tanren/ci.yml` PARSES against the `CiConfigV1` zod schema —
//      added for task #80 (apex v62 halt) so a malformed shape fails the test
//      instead of escaping to the live writer-checker-auditor loop.
//
// FAIL-LOUD STYLE: assertions throw `Error` (rather than `expect(cond, msg).toBe`)
// because the lint forbids 2-arg `expect`. A thrown error fails the it() with the
// full message naming the combo + the broken assertion.

import { describe, expect, it } from "vitest";
import {
  BASE_PROTECTED_FILES,
  composeTemplate,
  type Fragment,
  type FragmentLibrary,
  loadFragmentLibrary,
  type TemplateConfig,
  VirtualFileSystem,
} from "../src/engine/templates/index.js";
import { assertComposedCiYmlParsesAsCiConfigV1 } from "./helpers/templateCiYmlSchemaCheck.js";
import { assertJustfileBootstrapsFromFreshCheckout } from "./helpers/templateFreshBootstrapCheck.js";
import {
  isIncompatibleCombination,
  type NormalizedCombo,
  pickFirstMatchingRule,
} from "./helpers/templateFragmentIncompatibles.js";

// ---- Incompatible combinations (task #72) ---------------------------------
// The shared `INCOMPATIBLE_COMBINATIONS` list lives in
// `tests/helpers/templateFragmentIncompatibles.ts`; this harness filters it OUT
// of the "compose cleanly" loop. The corresponding "MUST throw" assertions live
// in `tests/templateFragmentDependsOnRuntimeMismatch.test.ts` — both harnesses
// read the same list so a new runtime-dependent fragment registers ONE entry and
// both pick it up automatically.

/** Throw a descriptive error so the failing test names the combo + broken
 * invariant. Centralized so every failure message in this file uses the same shape. */
function fail(message: string): never {
  throw new Error(message);
}

/**
 * Stable, human-readable slug for a combination. Forms the test name + the
 * `TemplateConfig.slug` used by the post-processed README. Two combinations that
 * differ only in addon order produce the SAME slug (addons enumerate in stable
 * library order via `ofKind("addon")`) so the matrix never double-counts permutations.
 */
function comboSlug(combo: NormalizedCombo): string {
  const head = combo.runtime;
  const optParts: string[] = [];
  if (combo.frontend !== undefined) optParts.push(`fe-${combo.frontend}`);
  if (combo.backend !== undefined) optParts.push(`be-${combo.backend}`);
  if (combo.db !== undefined) optParts.push(`db-${combo.db}`);
  if (combo.auth !== undefined) optParts.push(`auth-${combo.auth}`);
  const deployPart = `deploy-${combo.deploy}`;
  const addonsPart = combo.addons.length > 0 ? [`addons-${combo.addons.join("+")}`] : [];
  const examplesPart = combo.examples.length > 0 ? [`examples-${combo.examples.join("+")}`] : [];
  return [head, ...optParts, deployPart, ...addonsPart, ...examplesPart].join("__");
}

function comboToConfig(combo: NormalizedCombo): TemplateConfig {
  return {
    slug: comboSlug(combo),
    runtime: combo.runtime,
    ...(combo.frontend === undefined ? {} : { frontend: combo.frontend }),
    ...(combo.backend === undefined ? {} : { backend: combo.backend }),
    ...(combo.db === undefined ? {} : { db: combo.db }),
    ...(combo.auth === undefined ? {} : { auth: combo.auth }),
    deploy: combo.deploy,
    addons: [...combo.addons],
    examples: [...combo.examples],
  };
}

/**
 * Powerset of `xs`, returned in stable order. Subsets are listed by their bitmask
 * index ([], singletons, pairs, …). Used to enumerate every addon/example
 * combination the registry permits.
 */
function powerset<T>(xs: readonly T[]): readonly (readonly T[])[] {
  const out: (readonly T[])[] = [];
  const n = xs.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const subset: T[] = [];
    for (let i = 0; i < n; i++) {
      const item = xs[i];
      if (item !== undefined && (mask & (1 << i)) !== 0) subset.push(item);
    }
    out.push(subset);
  }
  return out;
}

function stripKindPrefix(id: string, prefix: string): string {
  if (!id.startsWith(prefix)) throw new Error(`expected fragment id "${id}" to start with "${prefix}"`);
  return id.slice(prefix.length);
}

/** The library-derived axes of the matrix — every axis is sourced from
 * `library.ofKind(...)` so a new registered fragment is picked up automatically. */
interface MatrixAxes {
  readonly runtimes: readonly TemplateConfig["runtime"][];
  readonly frontends: readonly (NonNullable<TemplateConfig["frontend"]> | undefined)[];
  readonly backends: readonly (NonNullable<TemplateConfig["backend"]> | undefined)[];
  readonly dbs: readonly (NonNullable<TemplateConfig["db"]> | undefined)[];
  readonly auths: readonly (NonNullable<TemplateConfig["auth"]> | undefined)[];
  readonly deploys: readonly TemplateConfig["deploy"][];
  readonly addonCombos: readonly (readonly TemplateConfig["addons"][number][])[];
  readonly exampleCombos: readonly (readonly TemplateConfig["examples"][number][])[];
}

function buildMatrixAxes(library: FragmentLibrary): MatrixAxes {
  return {
    runtimes: library.ofKind("runtime").map((f) => stripKindPrefix(f.id, "runtime-") as TemplateConfig["runtime"]),
    frontends: [
      undefined,
      ...library
        .ofKind("frontend")
        .map((f) => stripKindPrefix(f.id, "frontend-") as NonNullable<TemplateConfig["frontend"]>),
    ],
    backends: [
      undefined,
      ...library
        .ofKind("backend")
        .map((f) => stripKindPrefix(f.id, "backend-") as NonNullable<TemplateConfig["backend"]>),
    ],
    dbs: [
      undefined,
      ...library.ofKind("db").map((f) => stripKindPrefix(f.id, "db-") as NonNullable<TemplateConfig["db"]>),
    ],
    auths: [
      undefined,
      ...library.ofKind("auth").map((f) => stripKindPrefix(f.id, "auth-") as NonNullable<TemplateConfig["auth"]>),
    ],
    deploys: library.ofKind("deploy").map((f) => stripKindPrefix(f.id, "deploy-") as TemplateConfig["deploy"]),
    addonCombos: powerset(
      library.ofKind("addon").map((f) => stripKindPrefix(f.id, "addon-") as TemplateConfig["addons"][number]),
    ),
    exampleCombos: powerset(
      library.ofKind("example").map((f) => stripKindPrefix(f.id, "example-") as TemplateConfig["examples"][number]),
    ),
  };
}

interface ComboHead {
  readonly runtime: TemplateConfig["runtime"];
  readonly frontend: NonNullable<TemplateConfig["frontend"]> | undefined;
  readonly backend: NonNullable<TemplateConfig["backend"]> | undefined;
  readonly db: NonNullable<TemplateConfig["db"]> | undefined;
  readonly auth: NonNullable<TemplateConfig["auth"]> | undefined;
  readonly deploy: TemplateConfig["deploy"];
}

/** All `(runtime, frontend, backend, db, auth, deploy)` head tuples — the 6-axis
 * cross-product that the outer enumerator scans. Split into two generators so the
 * nested-loop depth stays under the lint's max-depth threshold (5). */
function* iterateHeads(axes: MatrixAxes): Generator<ComboHead> {
  for (const runtime of axes.runtimes) {
    for (const frontend of axes.frontends) {
      for (const backend of axes.backends) {
        yield* iterateTailHeads(axes, runtime, frontend, backend);
      }
    }
  }
}

function* iterateTailHeads(
  axes: MatrixAxes,
  runtime: ComboHead["runtime"],
  frontend: ComboHead["frontend"],
  backend: ComboHead["backend"],
): Generator<ComboHead> {
  for (const db of axes.dbs) {
    for (const auth of axes.auths) {
      for (const deploy of axes.deploys) {
        yield { runtime, frontend, backend, db, auth, deploy };
      }
    }
  }
}

/** Enumerate every combination the library can produce — the matrix-coverage
 * surface. Axes come from `library.ofKind(...)` so the matrix grows when a new
 * fragment is registered. INCOMPATIBLE_COMBINATIONS hits are pulled into the
 * `excluded` bucket — the included bucket gets the structural assertions; the
 * excluded bucket gets the MUST-throw assertion in the second describe() block
 * (task #72: previously these were silently filtered + skipped, now they are
 * positively asserted to throw `TemplateComposeError("dependency_runtime_mismatch")`). */
function enumerateMatrix(library: FragmentLibrary): {
  readonly included: readonly NormalizedCombo[];
  readonly excluded: readonly { readonly combo: NormalizedCombo; readonly reason: string }[];
} {
  const axes = buildMatrixAxes(library);
  if (axes.runtimes.length === 0) throw new Error("matrix-coverage: no runtime fragments registered");
  if (axes.deploys.length === 0) throw new Error("matrix-coverage: no deploy fragments registered");

  const included: NormalizedCombo[] = [];
  const excluded: { combo: NormalizedCombo; reason: string }[] = [];

  for (const head of iterateHeads(axes)) {
    for (const addons of axes.addonCombos) {
      for (const examples of axes.exampleCombos) {
        // Auth without db is incoherent (auth usually needs a user table; README
        // §6 documents the phase order). Skip silently — this is a phase-order
        // constraint, not a registry-dependency mismatch.
        if (head.auth !== undefined && head.db === undefined) continue;
        const combo: NormalizedCombo = { ...head, addons, examples };
        if (isIncompatibleCombination(combo)) {
          const rule = pickFirstMatchingRule(combo);
          excluded.push({ combo, reason: rule?.reason ?? "" });
          continue;
        }
        included.push(combo);
      }
    }
  }

  return { included, excluded };
}

/** Re-apply the fragments in compose order against a fresh VFS so we can capture
 * every env var any fragment declared — backs assertion #6 (every declared env var
 * lands in .env.example). */
async function captureAllFragmentEnvVars(
  config: TemplateConfig,
  library: FragmentLibrary,
): Promise<Map<string, string>> {
  const vfs = new VirtualFileSystem();
  const order: Fragment[] = [
    library.require("base"),
    library.require(`runtime-${config.runtime}`),
    ...(config.frontend === undefined ? [] : [library.require(`frontend-${config.frontend}`)]),
    ...(config.backend === undefined ? [] : [library.require(`backend-${config.backend}`)]),
    ...(config.db === undefined ? [] : [library.require(`db-${config.db}`)]),
    ...(config.auth === undefined ? [] : [library.require(`auth-${config.auth}`)]),
    ...config.addons.map((id) => library.require(`addon-${id}`)),
    ...config.examples.map((id) => library.require(`example-${id}`)),
    library.require(`deploy-${config.deploy}`),
  ];
  for (const fragment of order) await fragment.apply(vfs, config);
  return new Map(vfs.collectedEnvVars());
}

/** Parse the composed package.json + return its dependency objects for cross-check. */
function parsePackageJson(vfs: VirtualFileSystem): {
  readonly raw: Record<string, unknown>;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
} {
  const text = vfs.read("package.json");
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`composed package.json did not parse to an object: ${typeof parsed}`);
  }
  const raw = parsed as Record<string, unknown>;
  return {
    raw,
    dependencies: stringObject(raw["dependencies"], "package.json.dependencies"),
    devDependencies: stringObject(raw["devDependencies"], "package.json.devDependencies"),
  };
}

function stringObject(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object: ${typeof value}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") throw new Error(`${label}["${k}"] is not a string: ${typeof v}`);
    out[k] = v;
  }
  return out;
}

/** Assert `.tanren/ci.yml` had its placeholder substituted to the runtime's
 * declared reportPath. */
function assertCiYmlReportPath(
  slug: string,
  library: FragmentLibrary,
  combo: NormalizedCombo,
  vfs: VirtualFileSystem,
): void {
  const runtimeFragment = library.require(`runtime-${combo.runtime}`);
  const expectedReportPath = runtimeFragment.contract.reportPath;
  if (expectedReportPath === undefined) {
    fail(
      `runtime fragment "runtime-${combo.runtime}" did not declare contract.reportPath — every ` +
        `runtime must declare one for processCiYml to fill the evidence block.`,
    );
  }
  const ci = vfs.read(".tanren/ci.yml");
  if (!ci.includes(expectedReportPath)) {
    fail(
      `combo "${slug}" composed .tanren/ci.yml without the runtime's declared reportPath ` +
        `"${expectedReportPath}". processCiYml did not run, or substituted the wrong value.`,
    );
  }
  if (ci.includes("__TANREN_REPORT_PATH__")) {
    fail(
      `combo "${slug}" left the __TANREN_REPORT_PATH__ placeholder in .tanren/ci.yml — ` +
        `processCiYml's substitution was skipped.`,
    );
  }
}

/** Assert a mutation-testing config is present (`stryker.conf.mjs` on node-pnpm,
 * `.mutant.yml` on ruby-bundler — both runtimes emit a marker so this is portable). */
function assertMutationConfigPresent(slug: string, vfs: VirtualFileSystem): void {
  const hasNodeMutation = vfs.has("stryker.conf.mjs");
  const hasRubyMutation = vfs.has(".mutant.yml");
  if (!hasNodeMutation && !hasRubyMutation) {
    fail(
      `combo "${slug}" composed without a mutation-testing config (no stryker.conf.mjs and ` +
        `no .mutant.yml). Base's mutation-baseline test would fail in this template.`,
    );
  }
}

/** Assert `package.json` coherence on the node-pnpm path + assert its absence on
 * the ruby-bundler path. */
function assertPackageJsonCoherent(slug: string, combo: NormalizedCombo, vfs: VirtualFileSystem): void {
  if (combo.runtime === "node-pnpm") {
    const pkg = parsePackageJson(vfs);
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (version.length === 0) {
        fail(`combo "${slug}" package.json.dependencies["${name}"] is an empty version string`);
      }
    }
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      if (version.length === 0) {
        fail(`combo "${slug}" package.json.devDependencies["${name}"] is an empty version string`);
      }
    }
    // No duplicate key across deps + devDeps. (The composer's mergeMapInto throws
    // on a conflicting version WITHIN one bucket; the cross-bucket case is not
    // forbidden by the composer but a real fragment would never want it.)
    const depNames = new Set<string>(Object.keys(pkg.dependencies));
    for (const name of Object.keys(pkg.devDependencies)) {
      if (depNames.has(name)) {
        fail(
          `combo "${slug}" has dep "${name}" in both dependencies + devDependencies — this is ` +
            `a registry coordination bug (a fragment author must pick one bucket).`,
        );
      }
    }
  } else if (vfs.has("package.json")) {
    // ruby-bundler — package.json MUST NOT exist (a fragment leaked a node-only
    // file). processDeps gates on `vfs.has("package.json")` so a ruby template that
    // accidentally carried one would silently merge node deps into a ruby project.
    fail(
      `combo "${slug}" (ruby-bundler runtime) composed with a package.json — a node-only ` +
        `artifact leaked into a ruby template.`,
    );
  }
}

/** Assert every env var any fragment declared lands in .env.example. */
async function assertDeclaredEnvVarsLanded(
  slug: string,
  config: TemplateConfig,
  library: FragmentLibrary,
  vfs: VirtualFileSystem,
): Promise<void> {
  const declaredEnv = await captureAllFragmentEnvVars(config, library);
  if (declaredEnv.size === 0) return;
  if (!vfs.has(".env.example")) {
    fail(
      `combo "${slug}" declared ${declaredEnv.size} env var(s) but the composed VFS has ` +
        `no .env.example (processEnvVars was bypassed).`,
    );
  }
  const env = vfs.read(".env.example");
  for (const [key, value] of declaredEnv) {
    if (!env.includes(`${key}=${value}`)) {
      fail(`combo "${slug}" declared env var ${key}=${value} that did NOT land in .env.example.`);
    }
  }
}

/** Assert every base-protected file survived compose. */
function assertBaseProtectedFilesIntact(slug: string, vfs: VirtualFileSystem): void {
  for (const path of BASE_PROTECTED_FILES) {
    if (!vfs.has(path)) {
      fail(
        `combo "${slug}" composed without base-protected file "${path}" — the base/ structural ` +
          `guarantee was bypassed by some fragment in the chain.`,
      );
    }
  }
}

// Build the matrix once — describe() evaluates synchronously so the it() per combo
// is registered at test-discovery time + parallel-runs cleanly.
const MATRIX = enumerateMatrix(loadFragmentLibrary());

describe("template-fragment matrix coverage — every supported stack composes", () => {
  it("the matrix has at least one included combination", () => {
    if (MATRIX.included.length === 0) {
      fail(
        `the matrix produced 0 included combinations — every axis must have at least one fragment ` +
          `+ the INCOMPATIBLE_COMBINATIONS list cannot reject EVERY pairing.`,
      );
    }
    // Pin the test as assertion-bearing.
    expect(MATRIX.included.length).toBeGreaterThan(0);
  });

  it(`reports the matrix shape (included=${MATRIX.included.length}, excluded=${MATRIX.excluded.length})`, () => {
    // Trivial; the value is the test NAME, which prints in CI logs. Pins the
    // invariant that excluded combos are documented.
    for (const entry of MATRIX.excluded) {
      if (entry.reason.length === 0) {
        fail(`excluded combo ${comboSlug(entry.combo)} has an empty reason — every exclusion must be documented.`);
      }
    }
    expect(MATRIX.excluded.every((e) => e.reason.length > 0)).toBe(true);
  });

  for (const combo of MATRIX.included) {
    const slug = comboSlug(combo);
    it(`composes the "${slug}" matrix point cleanly`, async () => {
      const library = loadFragmentLibrary();
      const config = comboToConfig(combo);

      let vfs: VirtualFileSystem;
      try {
        vfs = await composeTemplate(config, library);
      } catch (cause) {
        throw new Error(`matrix combo "${slug}" failed to compose (${JSON.stringify(config)}): ${String(cause)}`, {
          cause,
        });
      }

      // (1) compose succeeded — reaching this point is the assertion.
      // (2) base-protected files intact.
      assertBaseProtectedFilesIntact(slug, vfs);
      // (3) ci.yml's reportPath token was substituted to a non-empty value.
      assertCiYmlReportPath(slug, library, combo, vfs);
      // (4) mutation-testing config present.
      assertMutationConfigPresent(slug, vfs);
      // (5) package.json coherence (or its principled absence on ruby).
      assertPackageJsonCoherent(slug, combo, vfs);
      // (6) every declared env var landed in .env.example.
      await assertDeclaredEnvVarsLanded(slug, config, library, vfs);
      // (7) ci.yml parses against the CiConfigV1 schema (task #80 — the apex v62
      // halt class: a base ci.yml emitted with non-schema tier vocabulary).
      assertComposedCiYmlParsesAsCiConfigV1(slug, vfs);
      // (8) the composed scaffold bootstraps from a FRESH checkout — no frozen
      // install primitive without a matching committed lockfile (task #84 —
      // apex v63 ERR_PNPM_NO_LOCKFILE halt class).
      assertJustfileBootstrapsFromFreshCheckout(slug, vfs);

      // Pin the test as assertion-bearing (vitest's no-standalone-expectations
      // rule). Every meaningful assertion above throws on failure.
      expect(vfs.toFlatMap()).not.toEqual({});
    });
  }
});

// The MUST-throw assertions for every excluded combo live in
// `tests/templateFragmentDependsOnRuntimeMismatch.test.ts` — same INCOMPATIBLE_COMBINATIONS
// list, flipped from "skip these" (pre-task-#72) to "compose MUST throw
// dependency_runtime_mismatch" (post-task-#72).
