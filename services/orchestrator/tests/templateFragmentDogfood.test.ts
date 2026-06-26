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

  it("BASE_JUSTFILE_TARGETS exposes exactly the base-declared targets", () => {
    expect(Array.from(BASE_JUSTFILE_TARGETS).sort()).toEqual(["bootstrap", "build", "tier-1", "tier-2", "tier-3"]);
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
