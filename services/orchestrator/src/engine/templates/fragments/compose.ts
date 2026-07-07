// THE TEMPLATE COMPOSER (PR-A foundation; docs/roadmap/templating-system.md §FRAGMENTS).
//
// Drives a `TemplateConfig` through a 9-phase pipeline, applying the matching fragment
// at each phase, then runs the post-processors to assemble the final justfile, env
// example, package.json, ci.yml, and README. The output is a `VirtualFileSystem`
// whose `hash()` is the dogfood-snapshot's review unit (a fragment change forces a
// snapshot diff PR).
//
// PIPELINE ORDER (load-bearing — a downstream phase reads contracts the upstream phase
// declared):
//   1. base        — ALWAYS first; emits the non-negotiable Tanren surface (justfile
//                    skeleton, .tanren/ci.yml shell, BDD home, mutation-baseline +
//                    functional-demo skeleton tests, .gitignore, mise.toml stub).
//   2. runtime     — the language/package-manager (one of `RuntimeId`). Declares
//                    `testRunner` + `reportPath` + `ciTier2` on its contract; the
//                    post-processor reads these to wire ci.yml's evidence block.
//   3. frontend    — optional, runs after runtime so it can ride the runtime's
//                    package.json + tsconfig + lockfile shape.
//   4. backend     — optional, same dependency as frontend.
//   5. db          — optional, runs after backend (so a db migration command can be
//                    wired into the backend's app).
//   6. auth        — optional, runs after db (auth usually depends on a user table).
//   7. addons      — every fragment of kind `addon` selected by config.addons[],
//                    applied in stable id order with the dependency resolver.
//   8. examples    — every fragment of kind `example` selected by config.examples[],
//                    applied last among feature fragments (an example uses everything
//                    above it).
//   9. deploy      — ALWAYS last; chooses the deploy target's wiring (fly/vercel/none)
//                    and seals the justfile/ci.yml posture so the deploy phase reads
//                    the FINAL test-runner contract.
//
// POST-PROCESS (after every fragment phase, runs as a single batch at the end so the
// finalizers see every fragment's declaration):
//   processDeps      — merges + dedupes + sorts package.json (node-pnpm only).
//   processEnvVars   — collects every addEnvVar into .env.example.
//   processJustfile  — splices every appendToJustfileTarget into base's justfile
//                      targets; throws on an UNKNOWN target name (a writer typo).
//   processCiYml     — fills tier-2 / tier-3 evidence declarations from the runtime's
//                      declared test runner; throws if no runtime declared one.
//   processReadme    — writes a minimal README naming the composed config.
//
// ENFORCEMENT (the user's load-bearing constraint — fragments fill hooks, never replace
// base scaffolding):
//   - the composer ASSERTS the `base` fragment is in the library; absent → throws
//     `TemplateComposeError("base", "BaseFragmentMissingError")`.
//   - the composer PRE-FLIGHTS the cross-runtime dependsOn check (task #72): every
//     non-runtime fragment whose `dependsOn` lists a runtime fragment other than the
//     active `config.runtime` throws `TemplateComposeError("dependency_runtime_mismatch")`
//     BEFORE any phase runs. The previous failure mode was silent acceptance: a
//     `runtime: ruby-bundler` + `frontend-react-router` config composed without
//     throwing because the frontend's `addPackageJsonDep` calls land in an internal
//     map and `processDeps` early-returns when `!vfs.has("package.json")` — node-only
//     deps were silently dropped. The pre-flight catches the mismatch deterministically
//     with a payload naming the conflicting fragment + required vs. active runtime.
//   - `processJustfile` throws on an unknown target (a fragment tried to use a hook
//     the base does not declare).
//   - `processCiYml` throws if NO runtime declared a `testRunner` (the evidence block
//     cannot be filled — every Tanren template must have a real test gate).
//   - the base's mutation-baseline + functional-demo SKELETON tests are
//     re-asserted PRESENT after every phase; a fragment that deleted them is rejected.

import { TemplateComposeError, type TemplateComposePhase } from "./composeError.js";
import { assertDependsOnRuntimeMatchesConfig } from "./dependencyRuntimeCheck.js";
import { hasMeaningfulAssertion, isCandidateTestPath, SCENARIO_HEADER } from "./functionalTestRecognizer.js";
import { BASE_FRAGMENT_ID, BASE_JUSTFILE_TARGETS, BASE_PROTECTED_FILES } from "./library/base.js";
import {
  type Fragment,
  type FragmentContract,
  type FragmentKind,
  type FragmentLibrary,
  type TemplateConfig,
  VirtualFileSystem,
} from "./types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("template-fragments-compose");

/** The deploy fragment id pattern. The composer derives the id from `config.deploy`
 * (e.g. `"deploy-fly"`) — the registry registers each deploy fragment under that key. */
export function deployFragmentId(deploy: TemplateConfig["deploy"]): string {
  return `deploy-${deploy}`;
}

/** The runtime fragment id pattern (`"runtime-node-pnpm"`, etc). */
export function runtimeFragmentId(runtime: TemplateConfig["runtime"]): string {
  return `runtime-${runtime}`;
}

export function frontendFragmentId(frontend: NonNullable<TemplateConfig["frontend"]>): string {
  return `frontend-${frontend}`;
}

export function backendFragmentId(backend: NonNullable<TemplateConfig["backend"]>): string {
  return `backend-${backend}`;
}

export function dbFragmentId(db: NonNullable<TemplateConfig["db"]>): string {
  return `db-${db}`;
}

export function authFragmentId(auth: NonNullable<TemplateConfig["auth"]>): string {
  return `auth-${auth}`;
}

export function addonFragmentId(addon: TemplateConfig["addons"][number]): string {
  return `addon-${addon}`;
}

export function exampleFragmentId(example: TemplateConfig["examples"][number]): string {
  return `example-${example}`;
}

/** The (kind, label, id) tuple a fragment slot resolves to. Used by
 * `selectFragmentConfig` so the missing-fragments enumeration walks the EXACT
 * id sequence `composeTemplate` will require — single source of truth. */
export interface PhaseFragmentRef {
  kind: FragmentKind;
  label: string;
  id: string;
}

/** Walk the same phase sequence `composeTemplate` will require for `config`, returning
 * the (kind, label, id) tuple for each slot — without applying any fragment. The
 * caller (`selectFragmentConfig`) uses this to decide whether the library covers the
 * config or whether the per-fragment authoring DAG must fill missing slots. */
export function compose(config: TemplateConfig): PhaseFragmentRef[] {
  const baseLabel = BASE_FRAGMENT_ID.replace(/^base-?/u, "") || "base";
  const out: PhaseFragmentRef[] = [
    { kind: "base", label: baseLabel, id: BASE_FRAGMENT_ID },
    { kind: "runtime", label: config.runtime, id: runtimeFragmentId(config.runtime) },
  ];
  if (config.frontend !== undefined) {
    out.push({ kind: "frontend", label: config.frontend, id: frontendFragmentId(config.frontend) });
  }
  if (config.backend !== undefined) {
    out.push({ kind: "backend", label: config.backend, id: backendFragmentId(config.backend) });
  }
  if (config.db !== undefined) {
    out.push({ kind: "db", label: config.db, id: dbFragmentId(config.db) });
  }
  if (config.auth !== undefined) {
    out.push({ kind: "auth", label: config.auth, id: authFragmentId(config.auth) });
  }
  for (const addon of config.addons) {
    out.push({ kind: "addon", label: addon, id: addonFragmentId(addon) });
  }
  for (const example of config.examples) {
    out.push({ kind: "example", label: example, id: exampleFragmentId(example) });
  }
  out.push({ kind: "deploy", label: config.deploy, id: deployFragmentId(config.deploy) });
  return out;
}

/**
 * Compose a template from a config + a fragment library. Returns the assembled VFS.
 * Throws `TemplateComposeError` on any compose-time failure — never returns a partial.
 */
export async function composeTemplate(config: TemplateConfig, library: FragmentLibrary): Promise<VirtualFileSystem> {
  if (!library.has(BASE_FRAGMENT_ID)) {
    throw new TemplateComposeError("base", "BaseFragmentMissingError", BASE_FRAGMENT_ID);
  }

  // PRE-FLIGHT (task #72): gather every fragment that compose() will require for
  // this config + walk the dependsOn graph. Any non-runtime fragment whose
  // dependsOn lists a `kind === "runtime"` fragment OTHER than the active runtime
  // is a cross-runtime mismatch — throw BEFORE the first phase runs so the error
  // fires deterministically and never inside a partially-composed VFS. (`compose`
  // already calls `library.require` per slot, so a missing-fragment slot still
  // throws here with its FragmentLibrary.require message — a missing fragment
  // upstream of composition is handled by `selectFragmentConfig`, which spawns
  // the per-fragment authoring DAG (F2) before compose is ever called.)
  const plannedFragments = compose(config).map((ref) => library.require(ref.id));
  assertDependsOnRuntimeMatchesConfig(plannedFragments, library, runtimeFragmentId(config.runtime));

  const vfs = new VirtualFileSystem();
  const applied: Fragment[] = [];

  await applyPhase(vfs, config, "base", [library.require(BASE_FRAGMENT_ID)], applied);
  await applyPhase(vfs, config, "runtime", [library.require(runtimeFragmentId(config.runtime))], applied);

  if (config.frontend !== undefined) {
    await applyPhase(vfs, config, "frontend", [library.require(frontendFragmentId(config.frontend))], applied);
  }
  if (config.backend !== undefined) {
    await applyPhase(vfs, config, "backend", [library.require(backendFragmentId(config.backend))], applied);
  }
  if (config.db !== undefined) {
    await applyPhase(vfs, config, "db", [library.require(dbFragmentId(config.db))], applied);
  }
  if (config.auth !== undefined) {
    await applyPhase(vfs, config, "auth", [library.require(authFragmentId(config.auth))], applied);
  }

  if (config.addons.length > 0) {
    const addons = library.resolveOrder(config.addons.map((id) => library.require(addonFragmentId(id))));
    await applyPhase(vfs, config, "addon", addons, applied);
  }
  if (config.examples.length > 0) {
    const examples = library.resolveOrder(config.examples.map((id) => library.require(exampleFragmentId(id))));
    await applyPhase(vfs, config, "example", examples, applied);
  }

  await applyPhase(vfs, config, "deploy", [library.require(deployFragmentId(config.deploy))], applied);

  // Post-processors run AFTER every fragment, so they see the full set of fragment
  // declarations (deps, env vars, just-hook fills, runtime contract) before finalizing.
  try {
    processDeps(vfs);
    processEnvVars(vfs);
    processJustfile(vfs);
    processCiYml(vfs, applied);
    processReadme(vfs, config);
    assertBaseInvariantsHeld(vfs);
    assertRuntimeAddedFunctionalTest(vfs);
  } catch (cause) {
    if (cause instanceof TemplateComposeError) throw cause;
    throw new TemplateComposeError("post_process", `post-process failed: ${String(cause)}`, undefined, { cause });
  }

  return vfs;
}

async function applyPhase(
  vfs: VirtualFileSystem,
  config: TemplateConfig,
  phase: TemplateComposePhase,
  fragments: readonly Fragment[],
  applied: Fragment[],
): Promise<void> {
  for (const fragment of fragments) {
    // Attribution seam (task #148 apex v75 fix): mark the current fragment on
    // the VFS so any `addEnvVar` reconciliation records the winner id — the
    // warn log below then names both origins.
    const reconciliationsBefore = vfs.envReconciliations().length;
    vfs.beginFragment(fragment.id);
    try {
      await fragment.apply(vfs, config);
    } catch (cause) {
      if (cause instanceof TemplateComposeError) throw cause;
      throw new TemplateComposeError(phase, `fragment ${fragment.id} threw: ${String(cause)}`, fragment.id, { cause });
    } finally {
      vfs.endFragment();
    }
    // Emit ONE warn line per new reconciliation this fragment triggered. The
    // trail is inspectable post-compose (isolation/dogfood tests), but the log
    // line is where an operator sees "later-wins picked up a conflict".
    const newReconciliations = vfs.envReconciliations().slice(reconciliationsBefore);
    for (const record of newReconciliations) {
      log.warn(`addEnvVar reconciled ${record.key} — later declaration wins`, {
        key: record.key,
        previousExample: record.previousExample,
        previousFragment: record.previousDeclaringFragment,
        currentExample: record.currentExample,
        currentFragment: record.currentDeclaringFragment ?? fragment.id,
        phase,
      });
    }
    applied.push(fragment);
  }
}

// ---- Post-processors -------------------------------------------------------

/** Stamp the assembled deps/devDeps into package.json (when present — the Ruby runtime
 * skips package.json entirely). Merges atop whatever the runtime fragment seeded;
 * sorts keys deterministically. */
function processDeps(vfs: VirtualFileSystem): void {
  if (!vfs.has("package.json")) return;
  vfs.mergeJson("package.json", (current) => {
    const deps = sortedObject(mergeMapInto(asObject(current["dependencies"]), vfs.collectedDeps()));
    const devDeps = sortedObject(mergeMapInto(asObject(current["devDependencies"]), vfs.collectedDevDeps()));
    const merged: Record<string, unknown> = { ...current };
    if (Object.keys(deps).length > 0) merged["dependencies"] = deps;
    if (Object.keys(devDeps).length > 0) merged["devDependencies"] = devDeps;
    return merged;
  });
}

function asObject(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

function mergeMapInto(into: Record<string, string>, from: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...into };
  for (const [key, value] of from) {
    const existing = out[key];
    if (existing !== undefined && existing !== value) {
      throw new TemplateComposeError(
        "post_process",
        `processDeps: ${key} declared twice with conflicting versions (${existing} vs ${value})`,
      );
    }
    out[key] = value;
  }
  return out;
}

function sortedObject<T>(input: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(input).sort()) out[key] = input[key] as T;
  return out;
}

/** Write `.env.example` from every collected env var, alphabetically. */
function processEnvVars(vfs: VirtualFileSystem): void {
  const collected = vfs.collectedEnvVars();
  if (collected.size === 0) return;
  const lines: string[] = ["# Generated by Tanren template composition. Add real values to .env (gitignored).", ""];
  for (const key of Array.from(collected.keys()).sort()) {
    lines.push(`${key}=${collected.get(key) ?? ""}`);
  }
  vfs.overwrite(".env.example", `${lines.join("\n")}\n`);
}

/** Splice fragment-supplied hook lines into the base/ justfile. Throws on an unknown
 * target (a writer typo — every fill must address a base-declared target). */
function processJustfile(vfs: VirtualFileSystem): void {
  if (!vfs.has("justfile")) {
    throw new TemplateComposeError("post_process", "processJustfile: base/ did not emit a justfile");
  }
  for (const target of vfs.justHookTargets()) {
    if (!BASE_JUSTFILE_TARGETS.has(target)) {
      throw new TemplateComposeError(
        "post_process",
        `processJustfile: fragment filled an unknown justfile target "${target}" ` +
          `(base declares: ${Array.from(BASE_JUSTFILE_TARGETS).sort().join(", ")})`,
      );
    }
  }
  const current = vfs.read("justfile");
  const next = current.replaceAll(/^# TANREN-HOOK: ([a-z0-9-]+)$/gmu, (_match, target: string) => {
    const lines = vfs.justHookLines(target);
    if (lines.length === 0) {
      return `  echo "no ${target} steps declared"`;
    }
    return lines.map((line) => `  ${line}`).join("\n");
  });
  vfs.overwrite("justfile", next);
}

/** Fill the evidence declarations on `.tanren/ci.yml`'s tier-2 + tier-3 from the
 * runtime's contract. Throws if no fragment declared a test runner. */
function processCiYml(vfs: VirtualFileSystem, applied: readonly Fragment[]): void {
  if (!vfs.has(".tanren/ci.yml")) {
    throw new TemplateComposeError("post_process", "processCiYml: base/ did not emit a .tanren/ci.yml");
  }
  const contract = mergeContracts(applied);
  if (contract.testRunner === undefined || contract.reportPath === undefined) {
    throw new TemplateComposeError(
      "post_process",
      `processCiYml: no fragment declared a test runner — every Tanren template ` +
        `must declare { testRunner, reportPath } on its runtime contract`,
    );
  }
  const reportPath = contract.reportPath;
  const next = vfs.read(".tanren/ci.yml").replaceAll("__TANREN_REPORT_PATH__", reportPath);
  vfs.overwrite(".tanren/ci.yml", next);
}

function mergeContracts(applied: readonly Fragment[]): FragmentContract {
  const merged: FragmentContract = {};
  for (const fragment of applied) {
    for (const [key, value] of Object.entries(fragment.contract)) {
      if (value === undefined) continue;
      const existing = (merged as Record<string, unknown>)[key];
      if (existing !== undefined && existing !== value) {
        throw new TemplateComposeError(
          "post_process",
          `mergeContracts: ${fragment.id} declared ${key}=${JSON.stringify(value)} ` +
            `but a prior fragment declared ${JSON.stringify(existing)}`,
          fragment.id,
        );
      }
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/** Minimal README naming the composed config. */
function processReadme(vfs: VirtualFileSystem, config: TemplateConfig): void {
  const lines: string[] = [
    `# ${config.slug}`,
    "",
    "Generated by the Tanren template composer (matrix-hit path).",
    "",
    "## Matrix point",
    "",
    `- runtime: \`${config.runtime}\``,
  ];
  if (config.frontend !== undefined) lines.push(`- frontend: \`${config.frontend}\``);
  if (config.backend !== undefined) lines.push(`- backend: \`${config.backend}\``);
  if (config.db !== undefined) lines.push(`- db: \`${config.db}\``);
  if (config.auth !== undefined) lines.push(`- auth: \`${config.auth}\``);
  lines.push(`- deploy: \`${config.deploy}\``);
  if (config.addons.length > 0) lines.push(`- addons: ${config.addons.map((a) => `\`${a}\``).join(", ")}`);
  if (config.examples.length > 0) lines.push(`- examples: ${config.examples.map((e) => `\`${e}\``).join(", ")}`);
  lines.push("", "## Tanren contract", "");
  lines.push("- `just bootstrap` provisions deps.");
  lines.push("- `just tier-1` runs lint + typecheck.");
  lines.push("- `just tier-2` runs tests + writes a JUnit report to `reports/junit.xml`.");
  lines.push("- `just tier-3` builds.");
  lines.push("- `just build` is the deploy artifact.");
  lines.push("", "See `.tanren/ci.yml` for the gate config.");
  vfs.overwrite("README.md", `${lines.join("\n")}\n`);
}

/** Re-assert every BASE_PROTECTED_FILES path survived composition (a fragment that
 * silently deleted the mutation-baseline / functional-demo skeleton is rejected). */
function assertBaseInvariantsHeld(vfs: VirtualFileSystem): void {
  for (const path of BASE_PROTECTED_FILES) {
    if (!vfs.has(path)) {
      throw new TemplateComposeError(
        "post_process",
        `assertBaseInvariantsHeld: base-protected file "${path}" is missing post-compose ` +
          `(a fragment removed it — base scaffolding is non-negotiable)`,
      );
    }
  }
}

// ---- The NB-1 hardening (PR-B): a non-skeleton functional test must be present.
//
// The user's load-bearing constraint is "strong behavior tie-ins to tests, and
// functional demos" — not just file existence. base/'s skeleton tests
// (`tests/mutation-baseline.test.ts` and `tests/functional-demo.test.ts`) only
// assert config files exist; a runtime fragment that ships ONLY those leaves the
// gate satisfiable by structural surface alone. This assertion requires the runtime
// (or any later fragment) to add at LEAST ONE non-skeleton test with a meaningful
// assertion, OR a BDD feature with a `Scenario:` block. A composition without one
// fails LOUD at compose time — the structural commitment becomes a behavioral one.
//
// The recognizer surface (path shape + content check) lives in
// `functionalTestRecognizer.ts` — apex v72 fix (task #144) extended it beyond
// TS/Ruby to Go/Python/Rust so a Go/Python/Rust runtime fragment can pass the
// smoke composition. See that file for the full flavor list + doctrine.

function assertRuntimeAddedFunctionalTest(vfs: VirtualFileSystem): void {
  const flat = vfs.toFlatMap();
  const paths = Object.keys(flat);

  // Pass A: any BDD feature with at least one Scenario block — strongest signal,
  // the user explicitly named "functional demos" + BDD as the load-bearing surface.
  const featureFiles = paths.filter((p) => p.startsWith("features/") && p.endsWith(".feature"));
  for (const path of featureFiles) {
    const content = flat[path] ?? "";
    if (SCENARIO_HEADER.test(content)) return;
  }

  // Pass B: any candidate test file (TS/JS, Ruby, Go, Python, Rust) with a
  // meaningful assertion. Skeleton paths are excluded by `isCandidateTestPath`.
  const candidatePaths = paths.filter((p) => isCandidateTestPath(p));
  for (const path of candidatePaths) {
    const content = flat[path] ?? "";
    if (hasMeaningfulAssertion(content)) return;
  }

  throw new TemplateComposeError(
    "post_process",
    "assertRuntimeAddedFunctionalTest: no runtime added a meaningful functional test or BDD scenario. " +
      "Recognized forms: TypeScript/JavaScript (tests/*.test.ts with expect(...).toBe/toEqual/toContain), " +
      "Ruby (spec/*_spec.rb with expect(...).to), Go (*_test.go with t.Errorf/t.Fatal/testify assert), " +
      "Python (test_*.py or *_test.py with assert or unittest.assertX), " +
      "Rust (tests/*.rs with assert_eq!/assert!), or Cucumber (features/*.feature with Scenario:). " +
      "Skeleton file-presence tests do NOT count — add a test with a meaningful assertion.",
  );
}
