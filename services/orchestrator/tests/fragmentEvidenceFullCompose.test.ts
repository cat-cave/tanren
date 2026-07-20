import { describe, expect, it } from "vitest";
import { compose, composeTemplate } from "../src/engine/templates/fragments/compose.js";
import {
  fragmentEvidenceContentDigest,
  FRAGMENT_EVIDENCE_MANIFEST_PATH,
} from "../src/engine/templates/fragments/fragmentEvidenceContract.js";
import { loadFragmentLibraryForTests } from "../src/engine/templates/fragments/library/index.js";
import type { TemplateComposeError } from "../src/engine/templates/fragments/composeError.js";
import {
  FragmentLibrary,
  type Fragment,
  type TemplateConfig,
  type VirtualFileSystem,
} from "../src/engine/templates/fragments/types.js";

function emptyFragment(id: string, kind: string): Fragment {
  return {
    id,
    kind,
    label: id.slice(kind.length + 1),
    version: "1.0.0",
    contract: {},
    apply: async (_vfs: VirtualFileSystem) => {},
  } as never;
}

const CONFIG: TemplateConfig = {
  slug: "mq12-evidence-all-slots",
  runtime: "node-pnpm",
  frontend: "react-router",
  backend: "api" as never,
  db: "postgres-prisma",
  auth: "session" as never,
  deploy: "none",
  addons: ["custom" as never],
  examples: ["smoke" as never],
};
const BASIC_CONFIG: TemplateConfig = {
  slug: "mq12-evidence-guards",
  runtime: "node-pnpm",
  deploy: "none",
  addons: [],
  examples: [],
};

const EVIDENCE_BASE = {
  schemaVersion: "fragment_evidence.v1" as const,
  junitReportPath: "reports/junit.xml",
  testSelector: { path: ".tanren/test-selector.json", format: "json" as const },
  behaviorManifest: { path: ".tanren/behavior-manifest.json", format: "json" as const },
};
const EVIDENCE = {
  ...EVIDENCE_BASE,
  contentDigest: fragmentEvidenceContentDigest({ ...EVIDENCE_BASE, contentDigest: `sha256:${"0".repeat(64)}` }),
};

describe("mq-12 evidence composition across every optional fragment slot", () => {
  it("keeps the runtime's one frozen evidence manifest while optional slots compose structurally", async () => {
    const library = loadFragmentLibraryForTests();
    for (const [id, kind] of [
      ["backend-api", "backend"],
      ["auth-session", "auth"],
      ["addon-custom", "addon"],
      ["example-smoke", "example"],
    ] as const) {
      library.register(emptyFragment(id, kind));
    }
    const runtime = library.require("runtime-node-pnpm");
    library.replaceForTests({ ...runtime, contract: { ...runtime.contract, evidence: EVIDENCE } });

    expect(compose(CONFIG).map((ref) => ref.id)).toEqual([
      "base",
      "runtime-node-pnpm",
      "frontend-react-router",
      "backend-api",
      "db-postgres-prisma",
      "auth-session",
      "addon-custom",
      "example-smoke",
      "deploy-none",
    ]);

    const vfs = await composeTemplate(CONFIG, library);
    const evidence = JSON.parse(vfs.read(FRAGMENT_EVIDENCE_MANIFEST_PATH));

    expect(evidence).toMatchObject({
      fragment: { id: "runtime-node-pnpm" },
      evidence: { schemaVersion: "fragment_evidence.v1" },
    });
    expect(vfs.read("README.md")).toContain("- backend: `api`");
    expect(vfs.read("README.md")).toContain("- auth: `session`");
    expect(vfs.read("README.md")).toContain("- addons: `custom`");
    expect(vfs.read("README.md")).toContain("- examples: `smoke`");
  });

  it("rejects a missing base and a fragment exception before it can leave a trusted partial composition", async () => {
    await expect(composeTemplate(BASIC_CONFIG, new FragmentLibrary())).rejects.toMatchObject({
      phase: "base",
      name: "TemplateComposeError",
    } satisfies Partial<TemplateComposeError>);

    const library = loadFragmentLibraryForTests();
    library.register({
      ...emptyFragment("addon-explodes", "addon"),
      apply: async () => {
        throw new Error("fragment writer failure");
      },
    });
    await expect(composeTemplate({ ...BASIC_CONFIG, addons: ["explodes" as never] }, library)).rejects.toMatchObject({
      phase: "addon",
      fragmentId: "addon-explodes",
    });
  });

  it("preserves post-process fail-closed boundaries for bad hooks, contract conflicts, and missing runtime evidence", async () => {
    const unknownHook = loadFragmentLibraryForTests();
    unknownHook.register({
      ...emptyFragment("addon-unknown-hook", "addon"),
      apply: async (vfs) => vfs.appendToJustfileTarget("not-a-base-target", ["echo unsafe"]),
    });
    await expect(composeTemplate({ ...BASIC_CONFIG, addons: ["unknown-hook" as never] }, unknownHook)).rejects.toThrow(
      /unknown justfile target/u,
    );

    const contractConflict = loadFragmentLibraryForTests();
    contractConflict.register({
      ...emptyFragment("addon-conflicting-report", "addon"),
      contract: { reportPath: "reports/other.xml" },
    });
    await expect(
      composeTemplate({ ...BASIC_CONFIG, addons: ["conflicting-report" as never] }, contractConflict),
    ).rejects.toThrow(/mergeContracts/u);

    const noRunner = loadFragmentLibraryForTests();
    const runtime = noRunner.require("runtime-node-pnpm");
    noRunner.replaceForTests({ ...runtime, contract: {} });
    await expect(composeTemplate(BASIC_CONFIG, noRunner)).rejects.toThrow(/no fragment declared a test runner/u);
  });

  it("does not continue when the base contract or meaningful runtime test surface disappears", async () => {
    const withoutJustfile = loadFragmentLibraryForTests();
    const base = withoutJustfile.require("base");
    withoutJustfile.replaceForTests({
      ...base,
      apply: async (vfs, config) => {
        await base.apply(vfs, config);
        vfs.delete("justfile");
      },
    });
    await expect(composeTemplate(BASIC_CONFIG, withoutJustfile)).rejects.toThrow(/did not emit a justfile/u);

    const withoutCi = loadFragmentLibraryForTests();
    const ciBase = withoutCi.require("base");
    withoutCi.replaceForTests({
      ...ciBase,
      apply: async (vfs, config) => {
        await ciBase.apply(vfs, config);
        vfs.delete(".tanren/ci.yml");
      },
    });
    await expect(composeTemplate(BASIC_CONFIG, withoutCi)).rejects.toThrow(/did not emit a .tanren\/ci.yml/u);

    const withoutFunctionalTest = loadFragmentLibraryForTests();
    const runtime = withoutFunctionalTest.require("runtime-node-pnpm");
    withoutFunctionalTest.replaceForTests({
      ...runtime,
      apply: async (vfs, config) => {
        await runtime.apply(vfs, config);
        vfs.delete("tests/demo.test.ts");
        vfs.write("features/empty.feature", "Feature: no runnable behavior\n");
      },
    });
    await expect(composeTemplate(BASIC_CONFIG, withoutFunctionalTest)).rejects.toThrow(
      /no runtime added a meaningful/u,
    );
  });
});
