// FRAGMENT DOGFOOD TEST (load-bearing — the self-maintenance mechanism).
//
// Three responsibilities, each a separate it():
//
//   1. Every fragment in the production library must `apply()` against a fresh VFS
//      WITHOUT throwing (in isolation — the apply contract is "no preconditions
//      except the fragment's declared dependencies").
//
//   2. Each CURATED matrix point composes through the full pipeline, and its
//      assembled VFS hashes match a stored snapshot at
//      `tests/__snapshots__/templates/<slug>.snap.json`. A fragment change forces a
//      snapshot diff PR — the snapshot IS the review unit. To regenerate, set
//      `TANREN_UPDATE_FRAGMENT_SNAPSHOTS=1`; running without it asserts the diff.
//
//   3. A deliberately non-compliant fragment (one that tries to fill a hook the
//      base does not declare; one that tries to remove a base-protected file) is
//      rejected at compose time with a `TemplateComposeError`.
//
// Snapshot review process: PR-A ships the initial snapshots; a fragment change in a
// follow-up PR re-runs this test with `TANREN_UPDATE_FRAGMENT_SNAPSHOTS=1`, commits
// the snapshot diff alongside the fragment change, and the reviewer reads the
// snapshot diff as the review unit (file-by-file content delta of every affected
// matrix point).

import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADDON_BIOME_ID,
  BASE_FRAGMENT_ID,
  BASE_JUSTFILE_TARGETS,
  BASE_PROTECTED_FILES,
  composeTemplate,
  type Fragment,
  FragmentLibrary,
  loadFragmentLibrary,
  RUNTIME_NODE_PNPM_ID,
  TemplateComposeError,
  type TemplateConfig,
  VirtualFileSystem,
} from "../src/engine/templates/index.js";
import {
  RUNTIME_NODE_PNPM_OWNED_DEVDEPS,
  RUNTIME_NODE_PNPM_OWNED_FILES,
} from "../src/engine/templates/fragments/library/runtime-node-pnpm.js";

const SNAPSHOT_DIR = join(import.meta.dirname, "__snapshots__", "templates");
const UPDATE = process.env["TANREN_UPDATE_FRAGMENT_SNAPSHOTS"] === "1";

// Curated matrix points — three: enough to exercise the composition surface (a
// node-pnpm-only minimal, a full node-pnpm + frontend + db + deploy, and a
// ruby-bundler proof the surface is stack-agnostic).
const CURATED_CONFIGS: readonly TemplateConfig[] = [
  {
    slug: "node-pnpm-minimal",
    runtime: "node-pnpm",
    deploy: "none",
    addons: [],
    examples: [],
  },
  {
    slug: "node-pnpm-react-prisma-fly",
    runtime: "node-pnpm",
    frontend: "react-router",
    db: "postgres-prisma",
    deploy: "fly",
    addons: [],
    examples: [],
  },
  {
    slug: "ruby-bundler-fly",
    runtime: "ruby-bundler",
    deploy: "fly",
    addons: [],
    examples: [],
  },
];

describe("template-fragment library — per-fragment apply", () => {
  for (const fragment of loadFragmentLibrary().all()) {
    it(`applies the "${fragment.id}" fragment to a fresh VFS without throwing`, async () => {
      const vfs = new VirtualFileSystem();
      const library = loadFragmentLibrary();
      // Always seed base; seed dependencies declared by the fragment under test.
      if (fragment.id !== BASE_FRAGMENT_ID) {
        await library.require(BASE_FRAGMENT_ID).apply(vfs, sampleConfig(fragment));
      }
      for (const depId of fragment.dependsOn ?? []) {
        await library.require(depId).apply(vfs, sampleConfig(fragment));
      }
      await fragment.apply(vfs, sampleConfig(fragment));
      // The fragment wrote SOMETHING (a no-op apply is a bug — the fragment is
      // either contract-only or had no business being in the library).
      expect(Object.keys(vfs.toFlatMap()).length).toBeGreaterThan(0);
    });
  }
});

describe("template-fragment library — curated matrix compose", () => {
  for (const config of CURATED_CONFIGS) {
    it(`composes "${config.slug}" and hash-matches its snapshot`, async () => {
      const library = loadFragmentLibrary();
      const vfs = await composeTemplate(config, library);
      const snapshot = buildSnapshot(vfs, library);
      const snapshotPath = join(SNAPSHOT_DIR, `${config.slug}.snap.json`);

      if (UPDATE) {
        mkdirSync(SNAPSHOT_DIR, { recursive: true });
        writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        return;
      }

      let stored: ReturnType<typeof buildSnapshot> | undefined;
      try {
        stored = JSON.parse(readFileSync(snapshotPath, "utf8")) as ReturnType<typeof buildSnapshot>;
      } catch (cause) {
        throw new Error(`snapshot missing at ${snapshotPath}. Run with TANREN_UPDATE_FRAGMENT_SNAPSHOTS=1 to seed.`, {
          cause,
        });
      }

      // Compute the per-file diff so the test failure NAMES every changed file —
      // reviewers read this as the review unit.
      const diff = diffFlatMaps(stored.flatMap, snapshot.flatMap);
      if (diff.length > 0) {
        const summary = diff.map((entry) => `  ${entry.path}: ${entry.kind}`).join("\n");
        throw new Error(
          `snapshot drift for "${config.slug}" (run TANREN_UPDATE_FRAGMENT_SNAPSHOTS=1 to update):\n${summary}`,
        );
      }
      expect(snapshot.hash).toBe(stored.hash);
      expect(snapshot.fragmentVersions).toEqual(stored.fragmentVersions);
    });
  }
});

describe("template-fragment library — runtime mutation contract (PR-B NB-2)", () => {
  // Every runtime fragment MUST fill the `just mutation` hook with a real mutation
  // tool AND write a meaningful mutation config. A runtime that ships an empty
  // mutation hook (or only the structural marker stryker.conf.mjs without a real
  // runner wiring) is a hook-bypass; this test catches it before snapshot review.
  for (const fragment of loadFragmentLibrary().ofKind("runtime")) {
    it(`runtime "${fragment.id}" fills the just-mutation hook with a real mutation tool`, async () => {
      const vfs = new VirtualFileSystem();
      const library = loadFragmentLibrary();
      await library.require(BASE_FRAGMENT_ID).apply(vfs, sampleConfig(fragment));
      for (const depId of fragment.dependsOn ?? []) {
        await library.require(depId).apply(vfs, sampleConfig(fragment));
      }
      await fragment.apply(vfs, sampleConfig(fragment));
      const mutationLines = vfs.justHookLines("mutation");
      expect(mutationLines.length, `${fragment.id} did not fill the just-mutation hook`).toBeGreaterThan(0);
      // A real mutation tool — stryker (node) or mutant (ruby). A runtime that
      // appends only `echo "todo"` is a structural-only fill and must be rejected.
      const joined = mutationLines.join("\n");
      expect(joined, `${fragment.id}'s just-mutation hook is not a real mutation tool`).toMatch(
        /(stryker\s+run|mutant\s+run)/u,
      );
    });

    it(`runtime "${fragment.id}" writes a meaningful mutation config`, async () => {
      const vfs = new VirtualFileSystem();
      const library = loadFragmentLibrary();
      await library.require(BASE_FRAGMENT_ID).apply(vfs, sampleConfig(fragment));
      for (const depId of fragment.dependsOn ?? []) {
        await library.require(depId).apply(vfs, sampleConfig(fragment));
      }
      await fragment.apply(vfs, sampleConfig(fragment));
      // node-pnpm writes stryker.conf.mjs that targets src/; ruby-bundler writes
      // .mutant.yml with an integration + matcher. The marker shim alone (object
      // with `runner: "mutant"`) doesn't qualify on its own — we additionally
      // require the .mutant.yml on the ruby path.
      const hasNodeMutation = vfs.has("stryker.conf.mjs") && /mutate:\s*\[/u.test(vfs.read("stryker.conf.mjs"));
      const hasRubyMutation = vfs.has(".mutant.yml") && /integration:\s*rspec/u.test(vfs.read(".mutant.yml"));
      expect(
        hasNodeMutation || hasRubyMutation,
        `${fragment.id} did not write a meaningful mutation config (stryker mutate:[] or .mutant.yml)`,
      ).toBe(true);
    });
  }
});

// REGRESSION (apex v90 `just mutation` halt). `pnpm stryker run` failed with "no
// TestRunner plugins were loaded" even though @stryker-mutator/vitest-runner was
// installed and root-resolvable. Under pnpm's DEFAULT isolated linker, Stryker's
// plugin-discovery glob (`@stryker-mutator/*`, resolved relative to @stryker-mutator/
// core's symlink realpath) never sees vitest-runner — each plugin is isolated in its
// own `.pnpm/...` dir. The node-pnpm runtime therefore MUST ship a pnpm-workspace.yaml
// with `nodeLinker: hoisted` (a flat, npm-like node_modules) so the glob finds the
// vitest-runner as a real sibling of core. NB: pnpm 10+ ignores `node-linker` in
// .npmrc, so the fix lives in pnpm-workspace.yaml — an .npmrc would be a silent no-op.
describe("template-fragment library — node-pnpm Stryker/pnpm-linker coherence (apex v90)", () => {
  it("node-pnpm scaffold ships pnpm-workspace.yaml with nodeLinker: hoisted, coherent with the stryker/vitest wiring", async () => {
    const library = loadFragmentLibrary();
    const vfs = await composeTemplate(
      { slug: "node-pnpm-minimal", runtime: "node-pnpm", deploy: "none", addons: [], examples: [] },
      library,
    );

    // The pnpm settings file exists and selects the hoisted (flat) node linker.
    expect(vfs.has("pnpm-workspace.yaml"), "node-pnpm scaffold must ship pnpm-workspace.yaml").toBe(true);
    const workspace = vfs.read("pnpm-workspace.yaml");
    expect(workspace, "pnpm-workspace.yaml must select the hoisted node linker").toMatch(
      /^\s*nodeLinker:\s*hoisted\s*$/mu,
    );

    // The owned-files single source of truth must list it (drives the authorer
    // collision guidance + the compose snapshot — it cannot silently drop).
    expect(RUNTIME_NODE_PNPM_OWNED_FILES).toContain("pnpm-workspace.yaml");

    // Coherence: the mutation runner Stryker loads (vitest) is exactly the flat-layout
    // plugin the hoisted linker makes discoverable, and the `just mutation` hook drives
    // stryker. If any of these three drift apart the gate breaks again.
    const stryker = vfs.read("stryker.conf.mjs");
    expect(stryker, "stryker must use the vitest test runner").toMatch(/testRunner:\s*["']vitest["']/u);
    expect(RUNTIME_NODE_PNPM_OWNED_DEVDEPS).toHaveProperty("@stryker-mutator/vitest-runner");
    expect(vfs.justHookLines("mutation").join("\n")).toMatch(/stryker\s+run/u);
  });
});

describe("template-fragment library — functional-test contract (PR-B NB-1)", () => {
  it("rejects a runtime that ships only the skeleton tests (no meaningful assertions)", async () => {
    // A runtime that satisfies the base/ presence checks structurally (writes a
    // stryker.conf.mjs + demo entry) but ships NO meaningful test must be rejected.
    const structuralOnly: Fragment = {
      id: RUNTIME_NODE_PNPM_ID,
      version: "0.0.0-structural",
      kind: "runtime",
      contract: {
        testRunner: "vitest",
        reportPath: "reports/junit.xml",
      },
      async apply(vfs) {
        vfs.write("package.json", `{\n  "name": "structural"\n}\n`);
        vfs.write("src/demo.ts", "export {};\n");
        vfs.write("stryker.conf.mjs", "export default {};\n");
        vfs.appendToJustfileTarget("bootstrap", ["echo bootstrap"]);
        vfs.appendToJustfileTarget("tier-1", ["echo tier1"]);
        vfs.appendToJustfileTarget("tier-2", ["echo tier2"]);
        vfs.appendToJustfileTarget("tier-3", ["echo tier3"]);
        vfs.appendToJustfileTarget("build", ["echo build"]);
        vfs.appendToJustfileTarget("mutation", ["pnpm stryker run"]);
      },
    };
    const library = loadFragmentLibrary();
    library.replaceForTests(structuralOnly);
    await expect(
      composeTemplate(
        {
          slug: "structural-only",
          runtime: "node-pnpm",
          deploy: "none",
          addons: [],
          examples: [],
        } as TemplateConfig,
        library,
      ),
    ).rejects.toThrow(/no runtime added a meaningful functional test or BDD scenario/u);
  });

  it("accepts a runtime that adds a BDD feature with a Scenario block", async () => {
    // A runtime that ships ONLY truthy-only ts tests AND a real BDD feature satisfies
    // the assertion via Pass A (the feature). Proves the BDD-only path is honored.
    const bddRuntime: Fragment = {
      id: RUNTIME_NODE_PNPM_ID,
      version: "0.0.0-bdd",
      kind: "runtime",
      contract: {
        testRunner: "vitest",
        reportPath: "reports/junit.xml",
      },
      async apply(vfs) {
        vfs.write("package.json", `{\n  "name": "bdd"\n}\n`);
        vfs.write("src/demo.ts", "export {};\n");
        vfs.write("stryker.conf.mjs", "export default {};\n");
        // Only a structural-only ts test — would fail Pass B alone.
        vfs.write(
          "tests/structural.test.ts",
          "import { it, expect } from 'vitest';\nit('runs', () => { expect(true).toBe(true); });\n",
        );
        vfs.write("features/demo.feature", "Feature: demo\n  Scenario: a real scenario\n    Given a step\n");
        vfs.appendToJustfileTarget("bootstrap", ["echo bootstrap"]);
        vfs.appendToJustfileTarget("tier-1", ["echo tier1"]);
        vfs.appendToJustfileTarget("tier-2", ["echo tier2"]);
        vfs.appendToJustfileTarget("tier-3", ["echo tier3"]);
        vfs.appendToJustfileTarget("build", ["echo build"]);
        vfs.appendToJustfileTarget("mutation", ["pnpm stryker run"]);
      },
    };
    const library = loadFragmentLibrary();
    library.replaceForTests(bddRuntime);
    await expect(
      composeTemplate(
        {
          slug: "bdd-only",
          runtime: "node-pnpm",
          deploy: "none",
          addons: [],
          examples: [],
        } as TemplateConfig,
        library,
      ),
    ).resolves.toBeDefined();
  });
});

describe("template-fragment library — enforcement (the load-bearing constraint)", () => {
  it("rejects a fragment that fills an unknown justfile target", async () => {
    // Override the biome addon with a deliberately-evil variant that fills a hook
    // the base does NOT declare. processJustfile must catch the unknown target.
    const evil: Fragment = {
      id: ADDON_BIOME_ID,
      version: "0.0.0-evil",
      kind: "addon",
      contract: {},
      async apply(vfs) {
        vfs.appendToJustfileTarget("release", ["echo evil"]);
      },
    };
    const library = loadFragmentLibrary();
    library.replaceForTests(evil);
    await expect(
      composeTemplate(
        {
          slug: "evil-hook",
          runtime: "node-pnpm",
          deploy: "none",
          addons: ["biome"],
          examples: [],
        } as TemplateConfig,
        library,
      ),
    ).rejects.toThrow(/unknown justfile target/u);
  });

  it("rejects a fragment that removes a base-protected file", async () => {
    const evil: Fragment = {
      id: ADDON_BIOME_ID,
      version: "0.0.0-evil",
      kind: "addon",
      contract: {},
      async apply(vfs) {
        // Truly remove the base/ functional-demo skeleton — assertBaseInvariantsHeld
        // must throw.
        vfs.delete("tests/functional-demo.test.ts");
      },
    };
    const library = loadFragmentLibrary();
    library.replaceForTests(evil);
    await expect(
      composeTemplate(
        {
          slug: "evil-remove",
          runtime: "node-pnpm",
          deploy: "none",
          addons: ["biome"],
          examples: [],
        } as TemplateConfig,
        library,
      ),
    ).rejects.toThrow(/base-protected file/u);
  });

  it("rejects composing when the base fragment is missing from the library", async () => {
    const library = new FragmentLibrary();
    for (const fragment of loadFragmentLibrary().all()) {
      if (fragment.id !== BASE_FRAGMENT_ID) library.register(fragment);
    }
    await expect(
      composeTemplate(
        {
          slug: "no-base",
          runtime: "node-pnpm",
          deploy: "none",
          addons: [],
          examples: [],
        } as TemplateConfig,
        library,
      ),
    ).rejects.toThrow(TemplateComposeError);
  });

  it("rejects when no runtime declares a test runner (the evidence wiring breaks)", async () => {
    const blankRuntime: Fragment = {
      id: RUNTIME_NODE_PNPM_ID,
      version: "0.0.0-blank",
      kind: "runtime",
      contract: {},
      async apply(vfs) {
        vfs.write("package.json", `{\n  "name": "blank"\n}\n`);
        vfs.appendToJustfileTarget("bootstrap", ["echo blank"]);
        vfs.appendToJustfileTarget("tier-1", ["echo blank"]);
        vfs.appendToJustfileTarget("tier-2", ["echo blank"]);
        vfs.appendToJustfileTarget("tier-3", ["echo blank"]);
        vfs.appendToJustfileTarget("build", ["echo blank"]);
        // Satisfy the base/ functional-demo + mutation-baseline presence checks.
        vfs.write("src/demo.ts", "export {};\n");
        vfs.write("stryker.conf.mjs", "export default {};\n");
      },
    };
    const library = loadFragmentLibrary();
    library.replaceForTests(blankRuntime);
    await expect(
      composeTemplate(
        {
          slug: "no-test-runner",
          runtime: "node-pnpm",
          deploy: "none",
          addons: [],
          examples: [],
        } as TemplateConfig,
        library,
      ),
    ).rejects.toThrow(/no fragment declared a test runner/u);
  });

  it("BASE_JUSTFILE_TARGETS exposes exactly the base-declared targets (includes PR-B mutation)", () => {
    expect(Array.from(BASE_JUSTFILE_TARGETS).sort()).toEqual([
      "bootstrap",
      "build",
      "mutation",
      "tier-1",
      "tier-2",
      "tier-3",
    ]);
  });

  it("BASE_PROTECTED_FILES names the non-negotiable base invariants", () => {
    expect([...BASE_PROTECTED_FILES].sort()).toEqual([
      ".gitignore",
      ".tanren/ci.yml",
      "justfile",
      "tests/functional-demo.test.ts",
      "tests/mutation-baseline.test.ts",
    ]);
  });
});

// ---- helpers ---------------------------------------------------------------

function sampleConfig(fragment: Fragment): TemplateConfig {
  const runtime = fragment.id.startsWith("runtime-ruby") ? "ruby-bundler" : "node-pnpm";
  return {
    slug: `sample-${fragment.id}`,
    runtime,
    deploy: "none",
    addons: [],
    examples: [],
  } as TemplateConfig;
}

interface FragmentSnapshot {
  readonly hash: string;
  readonly flatMap: Record<string, string>;
  readonly fragmentVersions: Record<string, string>;
}

function buildSnapshot(vfs: VirtualFileSystem, library: ReturnType<typeof loadFragmentLibrary>): FragmentSnapshot {
  const versions: Record<string, string> = {};
  for (const fragment of library.all()) versions[fragment.id] = fragment.version;
  return {
    hash: vfs.hash(),
    flatMap: vfs.toFlatMap(),
    fragmentVersions: versions,
  };
}

interface DiffEntry {
  readonly path: string;
  readonly kind: "added" | "removed" | "changed";
}

function diffFlatMaps(stored: Record<string, string>, current: Record<string, string>): DiffEntry[] {
  const out: DiffEntry[] = [];
  const all = new Set<string>([...Object.keys(stored), ...Object.keys(current)]);
  for (const path of Array.from(all).sort()) {
    const a = stored[path];
    const b = current[path];
    if (a === undefined && b !== undefined) out.push({ path, kind: "added" });
    else if (a !== undefined && b === undefined) out.push({ path, kind: "removed" });
    else if (a !== b) out.push({ path, kind: "changed" });
  }
  return out;
}
