// Tests for the per-fragment authoring DAG (F2 — docs/roadmap/templating-system.md).
//
// The flow under test: `buildFragmentAuthoring` runs an authorer (the deterministic
// in-memory authorer is used here as the test seam) over each missing spec,
// validates the produced TS body via `interpretOrgFragment` + smoke composition,
// persists the validated fragment, and returns the augmented library + any
// failedIds. On a fixed-point writer failure the run terminalizes and the failed
// id surfaces in `failedIds` so the parent derive can halt loud.

import { describe, expect, it } from "vitest";
import {
  buildFragmentAuthoring,
  type FragmentAuthoringEvents,
  type FragmentAuthorer,
  type FragmentPersistence,
  type FragmentSpec,
  loadUnifiedFragmentLibrary,
  type OrgFragmentSource,
} from "../src/engine/templates/index.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/index.js";
import { buildFakeFragmentAuthorer } from "./fixtures/fragmentAuthoring.js";

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

function recordingEvents(): { events: FragmentAuthoringEvents; calls: unknown[] } {
  const calls: unknown[] = [];
  const events: FragmentAuthoringEvents = {
    async emit(event) {
      calls.push(event);
    },
  };
  return { events, calls };
}

function inMemoryPersistence(): { persistence: FragmentPersistence; created: unknown[]; validated: string[] } {
  const created: unknown[] = [];
  const validated: string[] = [];
  const persistence: FragmentPersistence = {
    async create(input) {
      created.push(input);
      return { fragmentId: `${input.orgId}:${input.spec.id}:1.0.0` };
    },
    async markValidated(fragmentId) {
      validated.push(fragmentId);
    },
  };
  return { persistence, created, validated };
}

describe("buildFragmentAuthoring — happy path", () => {
  it("authors + validates + persists a missing addon fragment", async () => {
    const { events, calls } = recordingEvents();
    const { persistence, created, validated } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({
      authorer: buildFakeFragmentAuthorer(),
      persistence,
      events,
    });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "spellcheck")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([]);
    expect(created).toHaveLength(1);
    expect(validated).toEqual(["org_a:addon-spellcheck:1.0.0"]);
    // Started + succeeded events both emitted (no failed).
    const kinds = calls.map((c) => (c as { kind: string }).kind);
    expect(kinds).toContain("fragment.authoring.started");
    expect(kinds).toContain("fragment.authoring.succeeded");
    // The returned library includes the authored fragment under its id.
    expect(result.library.has("addon-spellcheck")).toBe(true);
  });
});

// A body that is not the constrained subset — fails the parse, identical every
// attempt ⇒ FIXED POINT after one rejection ⇒ failedIds includes id.
const failingAuthorer: FragmentAuthorer = async () => ({
  bodyTs: "this is not a valid fragment module",
});

describe("buildFragmentAuthoring — failure surfaces in failedIds (fixed-point halt)", () => {
  it("returns the failed id when the writer produces an un-parsable body that doesn't change", async () => {
    const { events, calls } = recordingEvents();
    const { persistence } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: failingAuthorer, persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "bogus")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual(["addon-bogus"]);
    const kinds = calls.map((c) => (c as { kind: string }).kind);
    expect(kinds).toContain("fragment.authoring.failed");
  });
});

// Authorer that produces a node-only addon body (uses addPackageJsonDep) without
// declaring a runtime dep on its own. The validator must DERIVE dependsOn from
// the parsed ops (audit finding #11). The persisted source's dependsOn must
// include runtime-node-pnpm even though the writer's body said nothing about it.
const nodeOnlyAddonAuthorer: FragmentAuthorer = async (input) => {
  const { spec: s } = input;
  const lines: string[] = [
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    ``,
    `export const fragment: Fragment = {`,
    `  id: "${s.id}",`,
    `  version: "1.0.0",`,
    `  kind: "${s.kind}",`,
    `  contract: ${JSON.stringify(s.requiredContract)},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    `    vfs.write("docs/${s.id}.md", "${s.id} fragment\\n");`,
    `    vfs.addPackageJsonDep("react", "^19.0.0");`,
    `  },`,
    `};`,
    `export default fragment;`,
  ];
  return { bodyTs: lines.join("\n") };
};

describe("buildFragmentAuthoring — audit finding #11 (derive dependsOn from ops)", () => {
  it("AUTO-DERIVES runtime-node-pnpm dependsOn for a fragment that uses addPackageJsonDep", async () => {
    const { events } = recordingEvents();
    const { persistence, created, validated } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: nodeOnlyAddonAuthorer, persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("frontend", "foo")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([]);
    expect(created).toHaveLength(1);
    expect(validated).toEqual(["org_a:frontend-foo:1.0.0"]);
    // The PERSISTED dependsOn must include runtime-node-pnpm — derived from the
    // body's `addPackageJsonDep` call, NOT from anything the writer declared.
    // This is the explicit contract that closes audit finding #11's silent-drop class.
    const createdInput = created[0] as { dependsOn: readonly string[] };
    expect(createdInput.dependsOn).toEqual(["runtime-node-pnpm"]);
  });

  it("derives EMPTY dependsOn for a fragment that uses only vfs.write (no pkg.json ops)", async () => {
    const { events } = recordingEvents();
    const { persistence, created } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: buildFakeFragmentAuthorer(), persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "spellcheck")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([]);
    const createdInput = created[0] as { dependsOn: readonly string[] };
    expect(createdInput.dependsOn).toEqual([]);
  });
});

// Authorer that fills the justfile bootstrap target with an unflagged frozen
// install — the regression class PR #701's static harness catches. The live
// smoke pipeline must reject the SAME class (audit finding #12).
const frozenLockfileBootstrapAuthorer: FragmentAuthorer = async (input) => {
  const { spec: s } = input;
  const lines: string[] = [
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    ``,
    `export const fragment: Fragment = {`,
    `  id: "${s.id}",`,
    `  version: "1.0.0",`,
    `  kind: "${s.kind}",`,
    `  contract: ${JSON.stringify(s.requiredContract)},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    `    vfs.write("docs/${s.id}.md", "${s.id}\\n");`,
    `    vfs.appendToJustfileTarget("bootstrap", ["pnpm install --frozen-lockfile"]);`,
    `  },`,
    `};`,
    `export default fragment;`,
  ];
  return { bodyTs: lines.join("\n") };
};

describe("buildFragmentAuthoring — audit finding #12 (live smoke runs runtime validators)", () => {
  it("REJECTS a fragment whose bootstrap fill includes `pnpm install --frozen-lockfile` (no committed lockfile)", async () => {
    const { events, calls } = recordingEvents();
    const { persistence, created } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: frozenLockfileBootstrapAuthorer, persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "frozen-bad")],
      lifecycle: lifecycle(),
    });
    // The smoke validator rejects the fragment — failedIds carries the spec id +
    // nothing got persisted (the writer's next iteration must address the reason).
    expect(result.failedIds).toEqual(["addon-frozen-bad"]);
    expect(created).toHaveLength(0);
    const failedEvent = calls.find((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as
      | { reason: string }
      | undefined;
    expect(failedEvent).toBeDefined();
    // The rejection reason must name the runtime validator that fired so the
    // writer's rework loop sees the specific halt class.
    expect(failedEvent?.reason).toContain("fresh-checkout bootstrap");
  });
});

describe("loadUnifiedFragmentLibrary — bundled + org-scoped shadowing", () => {
  it("returns the bundled library verbatim when no org fragments load", async () => {
    const library = await loadUnifiedFragmentLibrary("org_a", async () => []);
    expect(library.has("base")).toBe(true);
    expect(library.has("runtime-node-pnpm")).toBe(true);
    expect(library.has("frontend-remix")).toBe(true);
  });

  it("registers a new org fragment that doesn't shadow a bundled one", async () => {
    const orgSource: OrgFragmentSource = {
      fragmentId: "org_a:addon-spellcheck:1.0.0",
      kind: "addon",
      label: "spellcheck",
      version: "1.0.0",
      bodyTs: `apply(vfs, _config) {\n  vfs.write("docs/spellcheck.md", "Spellcheck addon\\n");\n}`,
      contract: {},
      dependsOn: [],
    };
    const library = await loadUnifiedFragmentLibrary("org_a", async () => [orgSource]);
    expect(library.has("addon-spellcheck")).toBe(true);
  });

  it("an org fragment SHADOWS a bundled fragment with the same (kind, label)", async () => {
    const overrideSource: OrgFragmentSource = {
      fragmentId: "org_a:addon-biome:2.0.0",
      kind: "addon",
      label: "biome",
      version: "2.0.0",
      bodyTs: `apply(vfs, _config) {\n  vfs.write("biome.org-override.json", "{}\\n");\n}`,
      contract: {},
      dependsOn: [],
    };
    const library = await loadUnifiedFragmentLibrary("org_a", async () => [overrideSource]);
    const fragment = library.require("addon-biome");
    // The shadowed fragment's version is the org-authored 2.0.0 (the bundled one was 1.0.0).
    expect(fragment.version).toBe("2.0.0");
  });
});
