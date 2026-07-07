// Full-library smoke composition — audit finding H5 (task #150). The prior
// smoke only exercised the fragment being authored + base + runtime + deploy;
// integration bugs where the authored fragment composed FINE in isolation but
// clashed with the bundled set the operator's real project would compose
// against were caught only at derive time — after credits were spent + the
// operator saw a garbled halt reason.
//
// The full-library smoke adds a SECOND compose pass with every bundled
// fragment compatible with the target runtime alongside the authored one. Two
// classes it catches:
//   - file collisions: the authored fragment writes a path a bundled fragment
//     also writes ⇒ VfsCollisionError at compose time,
//   - package.json dep-version conflicts: authored + bundled declare
//     conflicting versions of the same package,
//   - justfile-hook fills against unknown targets under integration.
//
// A fragment that composes cleanly in isolation AND alongside the full bundled
// set is validated + persisted; otherwise rejected with a distinguished reason.

import { describe, expect, it } from "vitest";
import {
  buildFragmentAuthoring,
  type FragmentAuthoringEvents,
  type FragmentAuthorer,
  type FragmentPersistence,
  type FragmentSpec,
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

function noopEvents(): FragmentAuthoringEvents {
  return { async emit() {} };
}

function inMemoryPersistence(): { persistence: FragmentPersistence; created: unknown[]; validated: string[] } {
  const created: unknown[] = [];
  const validated: string[] = [];
  const persistence: FragmentPersistence = {
    async createValidated(input) {
      created.push(input);
      const fragmentId = `${input.orgId}:${input.spec.id}:1.0.0`;
      validated.push(fragmentId);
      return { fragmentId };
    },
  };
  return { persistence, created, validated };
}

// An authorer producing an addon that WRITES A PATH bundled addon-biome already
// writes (`biome.json`). Isolated smoke passes (no other biome addon in the
// isolated config); full-library smoke MUST reject the collision because the
// operator's real project will compose both.
function collidingWithBiomeAuthorer(path: string): FragmentAuthorer {
  return async (input) => {
    const s = input.spec;
    const body = [
      `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
      `export const fragment: Fragment = {`,
      `  id: "${s.id}",`,
      `  version: "1.0.0",`,
      `  kind: "${s.kind}",`,
      `  contract: ${JSON.stringify(s.requiredContract)},`,
      `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
      `    vfs.write("${path}", "conflicting content");`,
      `  },`,
      `};`,
      `export default fragment;`,
    ].join("\n");
    return { bodyTs: body };
  };
}

// An authorer producing an addon that declares a package.json dep at a version
// that DIFFERS from what bundled remix declares (the bundled fragment pins
// react at a specific version — if the authored addon declares a conflicting
// version, processDeps throws at post-process time in the full-library smoke).
function conflictingReactVersionAuthorer(): FragmentAuthorer {
  return async (input) => {
    const s = input.spec;
    const body = [
      `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
      `export const fragment: Fragment = {`,
      `  id: "${s.id}",`,
      `  version: "1.0.0",`,
      `  kind: "${s.kind}",`,
      `  contract: ${JSON.stringify(s.requiredContract)},`,
      `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
      `    vfs.write("docs/${s.id}.md", "hi");`,
      `    vfs.addPackageJsonDep("react", "^0.0.1-conflicting");`,
      `  },`,
      `};`,
      `export default fragment;`,
    ].join("\n");
    return { bodyTs: body };
  };
}

// An authorer producing a CLEAN addon that ONLY writes to a unique docs path.
// Isolated + full-library smoke both pass.
function cleanAuthorer(): FragmentAuthorer {
  return async (input) => {
    const s = input.spec;
    const body = [
      `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
      `export const fragment: Fragment = {`,
      `  id: "${s.id}",`,
      `  version: "1.0.0",`,
      `  kind: "${s.kind}",`,
      `  contract: ${JSON.stringify(s.requiredContract)},`,
      `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
      `    vfs.write("docs/unique-${s.id}.md", "hi");`,
      `  },`,
      `};`,
      `export default fragment;`,
    ].join("\n");
    return { bodyTs: body };
  };
}

describe("fragment authoring — full-library smoke composition (audit finding H5)", () => {
  it("REJECTS a fragment that writes a file path a bundled fragment already writes", async () => {
    // biome.json is written by bundled addon-biome. An addon that ALSO writes
    // biome.json passes isolated smoke (no biome addon in isolated config) but
    // MUST fail the full-library smoke — that catches the real integration
    // conflict the operator's project would hit.
    const { persistence, created } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({
      authorer: collidingWithBiomeAuthorer("biome.json"),
      persistence,
      events: noopEvents(),
    });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "custom-linter")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual(["addon-custom-linter"]);
    expect(created).toHaveLength(0);
    const reason = result.failureReasons["addon-custom-linter"] ?? "";
    // The full-library smoke's rejection prefix names the class so the writer
    // sees "you passed isolated but broke integration".
    expect(reason).toContain("full-library smoke compose failed");
  });

  it("REJECTS a fragment declaring a package.json dep at a conflicting version with a bundled fragment", async () => {
    // The bundled frontend-remix declares react at a specific version. An
    // authored addon that declares react at a DIFFERENT version passes isolated
    // (no remix in isolated smoke), but the full-library smoke includes remix
    // and processDeps throws on the version conflict.
    const { persistence, created } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({
      authorer: conflictingReactVersionAuthorer(),
      persistence,
      events: noopEvents(),
    });
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "conflict-dep")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual(["addon-conflict-dep"]);
    expect(created).toHaveLength(0);
    const reason = result.failureReasons["addon-conflict-dep"] ?? "";
    expect(reason).toContain("full-library smoke compose failed");
    expect(reason).toContain("react");
  });

  it("ACCEPTS a fragment that composes cleanly in isolation AND alongside the full bundled set", async () => {
    const { persistence, created, validated } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({
      authorer: cleanAuthorer(),
      persistence,
      events: noopEvents(),
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
  });
});
