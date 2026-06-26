// FRAGMENT ISOLATION HARNESS (PR-D — `docs/roadmap/templating-system.md §FRAGMENTS).
//
// Complements `templateFragmentDogfood.test.ts`: that file pins SNAPSHOTS over a
// curated set of full compositions. This file enumerates the production library and
// composes EACH fragment against the SMALLEST VALID `TemplateConfig` that includes
// only `base` + the fragment under test + any phase-required dependency it declares.
// A fragment can therefore never silently regress the contracts it declares — if a
// reviewer adds a fragment that forgets to wire its declared `reportPath` through
// the composer's `processCiYml`, the corresponding isolation test fires + names the
// fragment + the broken contract.
//
// PER-FRAGMENT ASSERTIONS (each a separate it()):
//   a) compose succeeds (no `TemplateComposeError`).
//   b) every contract field the fragment declares is REFLECTED in the composed VFS:
//        - `reportPath`  → substituted into `.tanren/ci.yml`'s `reportPath` token.
//        - `testRunner`  → presence required by `processCiYml` (compose would throw
//                          on `(undefined, undefined)` so this is implicitly proven
//                          when compose succeeds with the runtime fragment).
//        - `dbMigrationsDir` → the fragment emitted the directory (some descendant
//                              path inside it is present in the VFS — typically a
//                              `.gitkeep`).
//        - `ciTier2`     → the declared shell command appears in the assembled
//                          `justfile`'s tier-2 target body (the fragment must back
//                          up its tier-2 contract with the actual hook fill).
//   c) every `BASE_PROTECTED_FILES` path survives compose (`assertBaseInvariantsHeld`
//      doubles this from inside the composer; we re-check at the test layer so a
//      regression surfaces named-per-fragment, not as a generic post-process throw).
//   d) every justfile target the fragment FILLED via `appendToJustfileTarget` is
//      reflected in the assembled `justfile` (each fill line appears in the body).
//   e) every `addEnvVar` call lands as a `KEY=VALUE` line in `.env.example`.
//
// THE "SMALLEST VALID CONFIG" — for a fragment of `kind: K`, the config is built so
// the composer runs `base` + the runtime appropriate to the fragment's runtime-side
// dependency (ruby for runtime-ruby-bundler + any fragment that declares it, node
// otherwise) + the fragment placed in its phase slot + a sentinel `deploy: "none"`.
// Cross-phase `dependsOn` references (e.g. an auth fragment that requires a specific
// db) are inferred from the dep's `kind` so the smallest config still resolves.
//
// DISCOVERY — we iterate the production `loadFragmentLibrary().all()` so a newly
// registered fragment is automatically covered by this harness with no test edit
// (the assertion set is generic over the fragment's declared contract + the VFS
// mutations it performs in isolation).
//
// FAIL-LOUD STYLE — assertion failures throw `Error` with a per-fragment message
// (rather than `expect(cond, msg).toBe(true)`), because the lint forbids both 2-arg
// `expect` and `expect` inside conditional blocks. A thrown error fails the it()
// with the full message naming the fragment + the specific broken contract — the
// readability goal of a per-fragment failure is preserved without the lint debt.

import { describe, expect, it } from "vitest";
import {
  BASE_FRAGMENT_ID,
  BASE_JUSTFILE_TARGETS,
  BASE_PROTECTED_FILES,
  composeTemplate,
  type Fragment,
  type FragmentLibrary,
  loadFragmentLibrary,
  type TemplateConfig,
  VirtualFileSystem,
} from "../src/engine/templates/index.js";

const RUBY_RUNTIME_ID = "runtime-ruby-bundler";

/** Throw a descriptive error so the failing test names the fragment + broken
 * contract. Centralized so every failure message in this file uses the same shape. */
function fail(message: string): never {
  throw new Error(message);
}

/**
 * Build the smallest valid `TemplateConfig` that includes `base` + the fragment
 * under test + any phase-required dependency it declares. Used by the isolation
 * harness so each fragment composes against the minimum surface area the composer
 * accepts (base + runtime + deploy are unconditional; everything else is opt-in).
 */
function smallestValidConfigFor(fragment: Fragment, library: FragmentLibrary): TemplateConfig {
  // Runtime selection: ruby-runtime fragment + any fragment that explicitly depends
  // on the ruby runtime → ruby; everything else (including the default + explicit
  // node deps) → node-pnpm. A fragment that depends on the OPPOSITE runtime of its
  // own kind is a registry bug; if it occurs, the compose-time dependency resolver
  // surfaces it as a `TemplateComposeError`.
  let runtime: TemplateConfig["runtime"] = "node-pnpm";
  if (fragment.id === RUBY_RUNTIME_ID) runtime = "ruby-bundler";
  for (const depId of fragment.dependsOn ?? []) {
    if (depId === RUBY_RUNTIME_ID) runtime = "ruby-bundler";
  }

  const config: TemplateConfig = {
    slug: `isolation-${fragment.id}`,
    runtime,
    deploy: "none",
    addons: [],
    examples: [],
  };

  // Place the fragment into its phase slot. `base` is implicit (always emitted by
  // the composer's first phase via `library.require(BASE_FRAGMENT_ID)`); `runtime`
  // is set above; everything else maps id → enum value by stripping the kind prefix.
  switch (fragment.kind) {
    case "base":
      break;
    case "runtime":
      config.runtime = stripKindPrefix(fragment.id, "runtime-") as TemplateConfig["runtime"];
      break;
    case "frontend":
      config.frontend = stripKindPrefix(fragment.id, "frontend-") as NonNullable<TemplateConfig["frontend"]>;
      break;
    case "backend":
      config.backend = stripKindPrefix(fragment.id, "backend-") as NonNullable<TemplateConfig["backend"]>;
      break;
    case "db":
      config.db = stripKindPrefix(fragment.id, "db-") as NonNullable<TemplateConfig["db"]>;
      break;
    case "auth":
      config.auth = stripKindPrefix(fragment.id, "auth-") as NonNullable<TemplateConfig["auth"]>;
      break;
    case "addon":
      config.addons = [stripKindPrefix(fragment.id, "addon-") as TemplateConfig["addons"][number]];
      break;
    case "example":
      config.examples = [stripKindPrefix(fragment.id, "example-") as TemplateConfig["examples"][number]];
      break;
    case "deploy":
      config.deploy = stripKindPrefix(fragment.id, "deploy-") as TemplateConfig["deploy"];
      break;
  }

  // Cross-phase dependency placement — a fragment that declares `dependsOn` against
  // another phase's fragment (e.g. an auth fragment requiring `db-postgres-prisma`)
  // needs that fragment present in the config or the composer never registers it.
  // We map dep.kind → the matching config slot. (runtime + base are handled above.)
  for (const depId of fragment.dependsOn ?? []) {
    const dep = library.require(depId);
    switch (dep.kind) {
      case "frontend":
        config.frontend = stripKindPrefix(depId, "frontend-") as NonNullable<TemplateConfig["frontend"]>;
        break;
      case "backend":
        config.backend = stripKindPrefix(depId, "backend-") as NonNullable<TemplateConfig["backend"]>;
        break;
      case "db":
        config.db = stripKindPrefix(depId, "db-") as NonNullable<TemplateConfig["db"]>;
        break;
      case "auth":
        config.auth = stripKindPrefix(depId, "auth-") as NonNullable<TemplateConfig["auth"]>;
        break;
      case "addon": {
        const addonId = stripKindPrefix(depId, "addon-") as TemplateConfig["addons"][number];
        if (!config.addons.includes(addonId)) config.addons = [...config.addons, addonId];
        break;
      }
      case "example": {
        const exampleId = stripKindPrefix(depId, "example-") as TemplateConfig["examples"][number];
        if (!config.examples.includes(exampleId)) config.examples = [...config.examples, exampleId];
        break;
      }
      case "deploy":
        config.deploy = stripKindPrefix(depId, "deploy-") as TemplateConfig["deploy"];
        break;
      case "runtime":
      case "base":
        break;
    }
  }

  return config;
}

function stripKindPrefix(id: string, prefix: string): string {
  if (!id.startsWith(prefix)) {
    throw new Error(`expected fragment id "${id}" to start with "${prefix}"`);
  }
  return id.slice(prefix.length);
}

/**
 * Re-run the fragment's `apply` against a fresh VFS pre-seeded with base + any
 * declared deps, so we can inspect what the fragment alone declared (env vars,
 * just-target fills, package.json deps) before the composer batches the post-
 * processors. Mirrors the dogfood test's `per-fragment apply` shape — same seam,
 * different assertion goal.
 */
async function captureFragmentDeclarations(
  fragment: Fragment,
  config: TemplateConfig,
  library: FragmentLibrary,
): Promise<{
  justHookTargets: readonly string[];
  justHookLines: Record<string, readonly string[]>;
  envVars: ReadonlyMap<string, string>;
}> {
  const vfs = new VirtualFileSystem();
  if (fragment.id !== BASE_FRAGMENT_ID) {
    await library.require(BASE_FRAGMENT_ID).apply(vfs, config);
  }
  for (const depId of fragment.dependsOn ?? []) {
    await library.require(depId).apply(vfs, config);
  }
  // Track what the fragment alone added — diff the BEFORE / AFTER snapshots so
  // dep-fragment declarations don't bleed in.
  const beforeJustTargets = new Set(vfs.justHookTargets());
  const beforeJustLinesPerTarget = new Map<string, readonly string[]>();
  for (const target of beforeJustTargets) beforeJustLinesPerTarget.set(target, [...vfs.justHookLines(target)]);
  const beforeEnv = new Map(vfs.collectedEnvVars());

  await fragment.apply(vfs, config);

  const justHookLines: Record<string, readonly string[]> = {};
  for (const target of vfs.justHookTargets()) {
    const after = vfs.justHookLines(target);
    const before = beforeJustLinesPerTarget.get(target) ?? [];
    const added = after.slice(before.length);
    if (added.length > 0) justHookLines[target] = added;
  }
  const envVars = new Map<string, string>();
  for (const [key, value] of vfs.collectedEnvVars()) {
    if (!beforeEnv.has(key)) envVars.set(key, value);
  }
  return {
    justHookTargets: Object.keys(justHookLines).sort(),
    justHookLines,
    envVars,
  };
}

/** Assert every contract field a fragment declares is reflected in the composed VFS.
 * Each unmet expectation throws with a per-fragment message naming the broken
 * contract — separated out so the it() body stays linear + readable. */
function assertContractReflected(
  fragment: Fragment,
  vfs: VirtualFileSystem,
  declarations: { justHookLines: Record<string, readonly string[]> },
): void {
  const contract = fragment.contract;
  if (contract.reportPath !== undefined) {
    const ci = vfs.read(".tanren/ci.yml");
    if (!ci.includes(contract.reportPath)) {
      fail(
        `fragment "${fragment.id}" declared contract.reportPath="${contract.reportPath}" ` +
          `but the composed .tanren/ci.yml does NOT contain it (processCiYml did not substitute the token).`,
      );
    }
    // The placeholder must be GONE — a leftover token means the substitution
    // ran with the wrong value, not "nothing happened".
    if (ci.includes("__TANREN_REPORT_PATH__")) {
      fail(
        `fragment "${fragment.id}" left the __TANREN_REPORT_PATH__ placeholder in .tanren/ci.yml ` +
          `(processCiYml substitution did not run).`,
      );
    }
  }
  if (contract.testRunner !== undefined && contract.testRunner.length === 0) {
    // testRunner is structurally required by processCiYml (compose throws when no
    // fragment declared one). We additionally pin that the declared value is
    // non-empty — a fragment that declared `testRunner: ""` would slip past
    // processCiYml's `undefined` check; this pins behavior, not just types.
    fail(`fragment "${fragment.id}" declared contract.testRunner as an empty string (must name a real runner)`);
  }
  if (contract.dbMigrationsDir !== undefined) {
    const flat = vfs.toFlatMap();
    const migrationsDir = contract.dbMigrationsDir;
    const hasDir = Object.keys(flat).some((p) => p === migrationsDir || p.startsWith(`${migrationsDir}/`));
    if (!hasDir) {
      fail(
        `fragment "${fragment.id}" declared contract.dbMigrationsDir="${migrationsDir}" ` +
          `but no composed-VFS path is inside that directory (the fragment must emit at least ` +
          `a .gitkeep so the directory survives a git commit).`,
      );
    }
  }
  if (contract.ciTier2 !== undefined) {
    // ciTier2 is the SHELL COMMAND the runtime's tier-2 hook should run. The
    // fragment must back its contract by actually filling tier-2 with that
    // command (or a recognizable substring) — a declared-but-unfilled tier-2
    // is the exact bug this assertion catches.
    const tier2Lines = declarations.justHookLines["tier-2"] ?? [];
    const tier2Joined = tier2Lines.join("\n");
    // A runtime sometimes splits its tier-2 fill across multiple lines (e.g.
    // `mkdir -p reports` followed by the actual runner). Match on the FIRST
    // word of the contract command (typically `pnpm`/`bundle`); a smarter
    // match would require parsing the shell, which is more brittle than this.
    const firstWord = contract.ciTier2.split(/\s+/u)[0] ?? "";
    if (firstWord.length === 0 || !tier2Joined.includes(firstWord)) {
      fail(
        `fragment "${fragment.id}" declared contract.ciTier2="${contract.ciTier2}" but tier-2 hook ` +
          `fill does NOT include the command's first word "${firstWord}" (lines: ${JSON.stringify(tier2Lines)}).`,
      );
    }
  }
}

/** Assert every base-protected file survived compose, naming the fragment that
 * may have removed it (the composer's `assertBaseInvariantsHeld` ALSO guards this
 * from inside; the layered check at the test surface produces a per-fragment
 * failure message instead of a generic post-process throw). */
function assertBaseProtectedFilesIntact(fragment: Fragment, vfs: VirtualFileSystem): void {
  for (const path of BASE_PROTECTED_FILES) {
    if (!vfs.has(path)) {
      fail(
        `fragment "${fragment.id}" composed without base-protected file "${path}" ` +
          `(the base/ structural guarantee was bypassed).`,
      );
    }
  }
}

/** Every justfile target the fragment filled must be a known base target + every
 * fill line must survive into the composed justfile. */
function assertJustHooksLanded(
  fragment: Fragment,
  vfs: VirtualFileSystem,
  declarations: { justHookTargets: readonly string[]; justHookLines: Record<string, readonly string[]> },
): void {
  const finalJustfile = vfs.read("justfile");
  for (const target of declarations.justHookTargets) {
    if (!BASE_JUSTFILE_TARGETS.has(target)) {
      fail(
        `fragment "${fragment.id}" filled an unknown justfile target "${target}" ` +
          `(base declares: ${Array.from(BASE_JUSTFILE_TARGETS).sort().join(", ")}).`,
      );
    }
    const lines = declarations.justHookLines[target] ?? [];
    for (const line of lines) {
      if (!finalJustfile.includes(line)) {
        fail(
          `fragment "${fragment.id}" declared a "${target}" hook line ${JSON.stringify(line)} ` +
            `that did NOT survive into the composed justfile.`,
        );
      }
    }
  }
}

/** Every env var the fragment declared lands as `KEY=VALUE` in `.env.example`. */
function assertEnvVarsLanded(
  fragment: Fragment,
  vfs: VirtualFileSystem,
  declarations: { envVars: ReadonlyMap<string, string> },
): void {
  if (declarations.envVars.size === 0) return;
  if (!vfs.has(".env.example")) {
    fail(
      `fragment "${fragment.id}" declared ${declarations.envVars.size} env var(s) but the ` +
        `composed VFS has no .env.example (processEnvVars did not run / was bypassed).`,
    );
  }
  const env = vfs.read(".env.example");
  for (const [key, value] of declarations.envVars) {
    const line = `${key}=${value}`;
    if (!env.includes(line)) {
      fail(`fragment "${fragment.id}" declared env var ${line} that did NOT land in .env.example.`);
    }
  }
}

describe("template-fragment isolation — every registered fragment composes against the minimal base", () => {
  for (const fragment of loadFragmentLibrary().all()) {
    it(`fragment "${fragment.id}" composes alone + preserves its declared contract`, async () => {
      const library = loadFragmentLibrary();
      const config = smallestValidConfigFor(fragment, library);

      const declarations = await captureFragmentDeclarations(fragment, config, library);

      // (a) compose succeeds — the absence of a throw IS the assertion. The
      // expect() at the end of this block keeps the test from being flagged as
      // assertion-free; the meaningful failure modes throw from the helpers above.
      let vfs: VirtualFileSystem;
      try {
        vfs = await composeTemplate(config, library);
      } catch (cause) {
        throw new Error(
          `fragment "${fragment.id}" failed to compose against its smallest valid config ` +
            `(${JSON.stringify(config)}): ${String(cause)}`,
          { cause },
        );
      }

      // (b) contract fields the fragment declares are reflected in the composed VFS.
      assertContractReflected(fragment, vfs, declarations);

      // (c) base-protected files survive compose.
      assertBaseProtectedFilesIntact(fragment, vfs);

      // (d) every justfile target the fragment filled is reflected in the final
      // justfile, and every target the fragment filled is a known base target.
      assertJustHooksLanded(fragment, vfs, declarations);

      // (e) every env var the fragment declared lands in `.env.example`.
      assertEnvVarsLanded(fragment, vfs, declarations);

      // Pin the test as assertion-bearing (vitest's no-standalone-expectations
      // rule + the suite's `--passWithNoTests`-style guard). Every meaningful
      // assertion above throws on failure; the expect here just trips the rule.
      expect(vfs.toFlatMap()).not.toEqual({});
    });
  }
});
