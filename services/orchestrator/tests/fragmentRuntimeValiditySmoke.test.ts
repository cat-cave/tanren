// Tests for the F2 runtime-validity smoke — the final step in
// `validateFragmentBody` that materializes the composed VFS into a temp dir and
// asks the runtime's dependency resolver whether the composed scaffold
// bootstraps. Composition-validity is NOT runtime-validity: a fragment can
// declare `"vitest": "^99.0.0"` in package.json, pass BOTH prior smokes, and
// still explode when the writer runs `pnpm install`. This module catches that.
//
// COVERAGE:
//   - Node fragment with a resolvable manifest → passes (fake invoker OK).
//   - Node fragment with a bad version → fails with actionable message (fake
//     invoker returns pnpm's ERR_PNPM_NO_MATCHING_VERSION shape).
//   - Ruby fragment via `bundle check` seam → passes / fails.
//   - Ruby fragment with no bundle seam → falls back to Gemfile syntax check.
//   - Non-recognized runtime → skip cleanly with log (returns ok).
//   - Wired via `buildFragmentAuthoring` — the runtime-validity failure propagates
//     into `failureReasons` and the fragment does NOT persist.
//   - `parsePnpmError` — the parser exposed for reuse (deterministic tests without
//     spawning pnpm).
//   - Real integration test (opt-in via TANREN_REAL_PNPM=1) — skipped by default.

import { describe, expect, it } from "vitest";
import {
  buildFragmentAuthoring,
  type FragmentAuthorer,
  type FragmentAuthoringEvents,
  type FragmentPersistence,
  type FragmentSpec,
  interpretOrgFragment,
  loadFragmentLibrary,
  parsePnpmError,
  type PnpmInvoker,
  type BundleInvoker,
  runRuntimeValiditySmoke,
  type SmokeResult,
  RUNTIME_RUBY_BUNDLER_ID,
} from "../src/engine/templates/index.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/index.js";

function lifecycle(): CaptureLifecycle {
  return {
    stack: "ts/pnpm",
    bootstrap: "pnpm install",
    tier1: "pnpm test",
    tier2: "pnpm test",
    tier3: "pnpm test",
    build: "pnpm build",
    deploy: "fly deploy",
    upgrade: "",
    toolchain: [],
  };
}

function spec(kind: FragmentSpec["kind"], label: string): FragmentSpec {
  return { kind, label, id: `${kind}-${label}`, requiredContract: {} };
}

/** Compose a valid addon fragment body from the constrained subset — the
 * simplest thing that composes: a single `vfs.write` to a unique docs path. */
function cleanAddonBody(id: string, kind: FragmentSpec["kind"]): string {
  return [
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    `export const fragment: Fragment = {`,
    `  id: "${id}",`,
    `  version: "1.0.0",`,
    `  kind: "${kind}",`,
    `  contract: {},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    `    vfs.write("docs/${id}.md", "hi");`,
    `  },`,
    `};`,
    `export default fragment;`,
  ].join("\n");
}

/** Compose an addon body that declares a package.json dep — the dep name gets
 * carried into the runtime-validity smoke's fake pnpm invoker via the
 * dependencies list of the composed package.json. */
function addonBodyWithDep(id: string, kind: FragmentSpec["kind"], depName: string, depVersion: string): string {
  return [
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    `export const fragment: Fragment = {`,
    `  id: "${id}",`,
    `  version: "1.0.0",`,
    `  kind: "${kind}",`,
    `  contract: {},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    `    vfs.write("docs/${id}.md", "hi");`,
    `    vfs.addPackageJsonDep("${depName}", "${depVersion}");`,
    `  },`,
    `};`,
    `export default fragment;`,
  ].join("\n");
}

function interpretedFragment(id: string, kind: FragmentSpec["kind"], bodyTs: string, dependsOn: readonly string[]) {
  return interpretOrgFragment({
    fragmentId: id,
    kind,
    label: id.replace(/^[^-]+-/u, ""),
    version: "1.0.0",
    bodyTs,
    contract: {},
    dependsOn,
  });
}

/** Narrow-or-throw helper so `expect` calls stay unconditional (satisfies the
 * `vitest/no-conditional-expect` lint). Throws a descriptive error when the
 * result kind doesn't match the expected one, so the vitest failure names the
 * actual kind + reason instead of the type checker's structural mismatch. */
function assertFailed(result: SmokeResult): asserts result is Extract<SmokeResult, { kind: "failed" }> {
  if (result.kind !== "failed") {
    throw new Error(`expected result.kind === "failed", got ${JSON.stringify(result)}`);
  }
}

function assertOk(result: SmokeResult): asserts result is Extract<SmokeResult, { kind: "ok" }> {
  if (result.kind !== "ok") {
    throw new Error(`expected result.kind === "ok", got ${JSON.stringify(result)}`);
  }
}

// ── Fake invoker fixtures (module-scoped per unicorn/consistent-function-scoping) ──

const okPnpmInvoker: PnpmInvoker = async () => ({ kind: "ok" });
const unavailableBundleInvoker: BundleInvoker = async () => ({ kind: "unavailable" });

function recordingPnpmInvoker(): { invoker: PnpmInvoker; calls: unknown[] } {
  const calls: unknown[] = [];
  const invoker: PnpmInvoker = async (input) => {
    calls.push(input);
    return { kind: "ok" };
  };
  return { invoker, calls };
}

function recordingBundleInvoker(): { invoker: BundleInvoker; calls: unknown[] } {
  const calls: unknown[] = [];
  const invoker: BundleInvoker = async (input) => {
    calls.push(input);
    return { kind: "ok" };
  };
  return { invoker, calls };
}

/** A pnpm invoker that throws if called — used to assert non-node runtimes
 * don't hit the pnpm path. */
const notCalledPnpm: PnpmInvoker = async () => {
  throw new Error("pnpm invoker should NOT be called for this runtime");
};

const badVersionPnpmInvoker: PnpmInvoker = async () => ({
  kind: "failed",
  message: "no matching version for vitest@^99.0.0",
});

const leftPadPnpmInvoker: PnpmInvoker = async () => ({
  kind: "failed",
  message: "no matching version for left-pad-fake@^99.0.0",
});

const missingGemBundleInvoker: BundleInvoker = async () => ({
  kind: "failed",
  message: "Could not find gem 'made-up-gem-99.0.0'",
});

describe("runRuntimeValiditySmoke — node-pnpm runtime", () => {
  it("PASSES when the fake pnpm invoker returns ok", async () => {
    const s = spec("addon", "clean-node");
    const body = cleanAddonBody(s.id, "addon");
    const fragment = interpretedFragment(s.id, "addon", body, []);
    const { invoker, calls } = recordingPnpmInvoker();
    const result = await runRuntimeValiditySmoke({
      spec: s,
      fragment,
      derivedDependsOn: [],
      deps: { pnpmInvoker: invoker },
    });
    expect(result).toEqual({ kind: "ok", dependsOn: [] });
    expect(calls).toHaveLength(1);
    // The invoker got a real cwd path (the temp dir where the VFS was materialized).
    expect((calls[0] as { cwd: string }).cwd).toMatch(/tanren-runtime-validity-addon-clean-node/u);
  });

  it("FAILS with an actionable rejection when the fake pnpm invoker rejects with a specific unresolved dep", async () => {
    const s = spec("addon", "bad-version");
    const body = addonBodyWithDep(s.id, "addon", "vitest", "^99.0.0");
    const fragment = interpretedFragment(s.id, "addon", body, ["runtime-node-pnpm"]);
    const result = await runRuntimeValiditySmoke({
      spec: s,
      fragment,
      derivedDependsOn: ["runtime-node-pnpm"],
      deps: { pnpmInvoker: badVersionPnpmInvoker },
    });
    assertFailed(result);
    // The rejection message names WHICH dep is broken so the writer's next
    // rework attempt sees the specific problem.
    expect(result.reason).toContain("runtime-validity smoke rejected");
    expect(result.reason).toContain("pnpm install rejected");
    expect(result.reason).toContain("vitest");
    expect(result.reason).toContain("^99.0.0");
  });
});

describe("runRuntimeValiditySmoke — ruby-bundler runtime", () => {
  // The ruby smoke composes against the BUNDLED runtime-ruby-bundler fragment
  // (the composer's post-processors require a runtime with { testRunner,
  // reportPath } declared — the bundled one carries those). The spec models the
  // "operator re-authors the ruby runtime" scenario; passing the bundled
  // fragment through means we're validating the real ruby scaffold + the smoke
  // seam wiring, not authoring correctness (that lives in other tests).
  const rubyFragment = loadFragmentLibrary().require(RUNTIME_RUBY_BUNDLER_ID);
  const rubySpec: FragmentSpec = {
    kind: "runtime",
    label: "ruby-bundler",
    id: RUNTIME_RUBY_BUNDLER_ID,
    requiredContract: {},
  };

  it("uses the bundle invoker when wired and returns its verdict", async () => {
    const { invoker, calls } = recordingBundleInvoker();
    const result = await runRuntimeValiditySmoke({
      spec: rubySpec,
      fragment: rubyFragment,
      derivedDependsOn: [],
      deps: { pnpmInvoker: notCalledPnpm, bundleInvoker: invoker },
    });
    assertOk(result);
    expect(calls).toHaveLength(1);
    // The invoker got a real gemfile path.
    expect((calls[0] as { gemfilePath: string }).gemfilePath).toMatch(/Gemfile$/u);
  });

  it("REJECTS with the bundle invoker's failure message", async () => {
    const result = await runRuntimeValiditySmoke({
      spec: rubySpec,
      fragment: rubyFragment,
      derivedDependsOn: [],
      deps: { pnpmInvoker: notCalledPnpm, bundleInvoker: missingGemBundleInvoker },
    });
    assertFailed(result);
    expect(result.reason).toContain("bundle check rejected");
    expect(result.reason).toContain("made-up-gem-99.0.0");
  });

  it("falls back to the Gemfile syntax check when the bundle invoker reports unavailable", async () => {
    const result = await runRuntimeValiditySmoke({
      spec: rubySpec,
      fragment: rubyFragment,
      derivedDependsOn: [],
      deps: { pnpmInvoker: notCalledPnpm, bundleInvoker: unavailableBundleInvoker },
    });
    // The bundled runtime-ruby-bundler fragment ships a well-formed Gemfile
    // (source rubygems + gem lines), so the fallback syntax check passes.
    expect(result.kind).toBe("ok");
  });

  it("falls back to the Gemfile syntax check when NO bundle invoker is wired at all", async () => {
    const result = await runRuntimeValiditySmoke({
      spec: rubySpec,
      fragment: rubyFragment,
      derivedDependsOn: [],
      deps: { pnpmInvoker: notCalledPnpm },
    });
    expect(result.kind).toBe("ok");
  });
});

describe("runRuntimeValiditySmoke — unrecognized runtime", () => {
  it("skips cleanly + returns ok when the runtime language does not map", async () => {
    // A runtime fragment whose label maps to no supported language. The runtime
    // language check is normally done up-front by `authorOneFragment`; here we
    // exercise the smoke's OWN skip branch by hand-authoring a fragment whose
    // dependsOn chain names an unknown runtime and passing it as a non-runtime
    // spec (so the up-front language check doesn't fire).
    const s: FragmentSpec = { kind: "runtime", label: "haskell", id: "runtime-haskell", requiredContract: {} };
    const body = cleanAddonBody(s.id, "runtime");
    const fragment = interpretedFragment(s.id, "runtime", body, []);
    const result = await runRuntimeValiditySmoke({
      spec: s,
      fragment,
      derivedDependsOn: [],
      deps: { pnpmInvoker: notCalledPnpm },
    });
    assertOk(result);
    expect(result.dependsOn).toEqual([]);
  });
});

describe("parsePnpmError — actionable rejection message extraction", () => {
  it("names the specific package + version on ERR_PNPM_NO_MATCHING_VERSION", () => {
    const output = [
      "  ERR_PNPM_NO_MATCHING_VERSION  No matching version found for vitest@^99.0.0",
      "",
      'The latest release of vitest is "4.0.0".',
    ].join("\n");
    const parsed = parsePnpmError(output);
    expect(parsed).toContain("no matching version for vitest@^99.0.0");
  });

  it("falls through to the first line when no pnpm error code matches", () => {
    const parsed = parsePnpmError("something unstructured happened\nline 2");
    expect(parsed).toBe("something unstructured happened");
  });

  it("returns a sentinel string when the output is empty", () => {
    expect(parsePnpmError("")).toBe("install failed with no output");
  });

  it("names the specific unmet peer when the output reports one", () => {
    const output = "unmet peer react@^18.0.0";
    expect(parsePnpmError(output)).toContain("unmet peer dependency react@^18.0.0");
  });
});

describe("buildFragmentAuthoring — runtime-validity failure short-circuits persist", () => {
  it("propagates a runtime-validity failure into failureReasons + does NOT persist", async () => {
    const s = spec("addon", "runtime-bad");
    const authorer: FragmentAuthorer = async () => ({
      bodyTs: addonBodyWithDep(s.id, "addon", "left-pad-fake", "^99.0.0"),
    });
    const created: unknown[] = [];
    const persistence: FragmentPersistence = {
      async createValidated(input) {
        created.push(input);
        return { fragmentId: `${input.orgId}:${input.spec.id}:1.0.0` };
      },
    };
    const events: FragmentAuthoringEvents = { async emit() {} };
    const runner = buildFragmentAuthoring({
      authorer,
      persistence,
      events,
      runtimeValiditySmoke: { pnpmInvoker: leftPadPnpmInvoker },
    });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [s],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([s.id]);
    expect(created).toHaveLength(0);
    const reason = result.failureReasons[s.id] ?? "";
    expect(reason).toContain("runtime-validity smoke rejected");
    expect(reason).toContain("left-pad-fake");
  });

  it("proceeds to persist when the runtime-validity smoke passes", async () => {
    const s = spec("addon", "runtime-good");
    const authorer: FragmentAuthorer = async () => ({ bodyTs: cleanAddonBody(s.id, "addon") });
    const created: unknown[] = [];
    const persistence: FragmentPersistence = {
      async createValidated(input) {
        created.push(input);
        return { fragmentId: `${input.orgId}:${input.spec.id}:1.0.0` };
      },
    };
    const events: FragmentAuthoringEvents = { async emit() {} };
    const runner = buildFragmentAuthoring({
      authorer,
      persistence,
      events,
      runtimeValiditySmoke: { pnpmInvoker: okPnpmInvoker },
    });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [s],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([]);
    expect(created).toHaveLength(1);
  });

  it("SKIPS the runtime-validity gate when no deps are wired — earlier smokes are still authoritative", async () => {
    // Existing tests that don't wire runtimeValiditySmoke MUST continue passing
    // (backward-compat) — the fragment persists on the strength of the two
    // composition-validity smokes alone.
    const s = spec("addon", "no-runtime-smoke-wired");
    const authorer: FragmentAuthorer = async () => ({ bodyTs: cleanAddonBody(s.id, "addon") });
    const created: unknown[] = [];
    const persistence: FragmentPersistence = {
      async createValidated(input) {
        created.push(input);
        return { fragmentId: `${input.orgId}:${input.spec.id}:1.0.0` };
      },
    };
    const events: FragmentAuthoringEvents = { async emit() {} };
    const runner = buildFragmentAuthoring({ authorer, persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [s],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([]);
    expect(created).toHaveLength(1);
  });
});

// ── Real integration test (opt-in) ──────────────────────────────────────────
//
// This test actually spawns pnpm — it is DISABLED by default so `just fast-check`
// stays deterministic + fast. Set `TANREN_REAL_PNPM=1` to opt in (e.g. a local
// verification pass or a nightly job). The test asserts the LIVE invoker built
// by `buildLivePnpmInvoker` runs pnpm against the composed VFS + surfaces an
// actionable error when the writer declares an unresolvable version.
//
describe.skipIf(process.env.TANREN_REAL_PNPM !== "1")("runRuntimeValiditySmoke — real pnpm integration", () => {
  it("spawns real pnpm + rejects a bad version with an actionable message", async () => {
    // Lazy-import so a missing pnpm binary in a non-opt-in env doesn't break
    // module load.
    const smokeMod = await import("../src/engine/templates/fragments/runtimeValiditySmoke.js");
    const liveMod = await import("../src/engine/templates/fragments/runtimeValiditySmokeLive.js");
    const s = spec("addon", "real-pnpm-bad");
    const body = addonBodyWithDep(s.id, "addon", "vitest", "^999999.0.0");
    const fragment = interpretedFragment(s.id, "addon", body, ["runtime-node-pnpm"]);
    const result = await smokeMod.runRuntimeValiditySmoke({
      spec: s,
      fragment,
      derivedDependsOn: ["runtime-node-pnpm"],
      deps: { pnpmInvoker: liveMod.buildLivePnpmInvoker() },
    });
    assertFailed(result);
    expect(result.reason).toContain("vitest");
  });
});

describe("live invoker factories — smoke-only wiring assertion", () => {
  // These builders are the production wirings the orchestrator's route wiring
  // hands into `FragmentAuthoringDeps.runtimeValiditySmoke`. Neither is
  // exercised at the unit-test tier (both spawn real subprocesses); this test
  // asserts the factory shape so knip sees the exports as used AND so a
  // refactor that accidentally breaks the factory signature fails here loudly.
  it("both live invoker factories return typed callables", async () => {
    const liveMod = await import("../src/engine/templates/fragments/runtimeValiditySmokeLive.js");
    expect(typeof liveMod.buildLivePnpmInvoker).toBe("function");
    expect(typeof liveMod.buildLiveBundleInvoker).toBe("function");
    expect(typeof liveMod.buildLivePnpmInvoker()).toBe("function");
    expect(typeof liveMod.buildLiveBundleInvoker()).toBe("function");
  });
});
