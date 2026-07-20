import { describe, expect, it } from "vitest";
import { composeTemplate } from "../src/engine/templates/fragments/compose.js";
import {
  FragmentEvidenceContractV1Schema,
  FragmentEvidenceManifestV1Schema,
  fragmentEvidenceContentDigest,
  FRAGMENT_EVIDENCE_MANIFEST_PATH,
} from "../src/engine/templates/fragments/fragmentEvidenceContract.js";
import { loadFragmentLibraryForTests } from "../src/engine/templates/fragments/library/index.js";

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

describe("FragmentEvidenceContractV1", () => {
  it("strictly round-trips a frozen, declarative runtime contract into the composed repository artifact", async () => {
    const library = loadFragmentLibraryForTests();
    const runtime = library.require("runtime-node-pnpm");
    library.replaceForTests({ ...runtime, contract: { ...runtime.contract, evidence: EVIDENCE } });
    const vfs = await composeTemplate(
      {
        slug: "evidence-contract",
        runtime: "node-pnpm",
        deploy: "none",
        addons: [],
        examples: [],
      },
      library,
    );
    const manifest = FragmentEvidenceManifestV1Schema.parse(JSON.parse(vfs.read(FRAGMENT_EVIDENCE_MANIFEST_PATH)));
    expect(manifest).toEqual({
      schemaVersion: "fragment_evidence_manifest.v1",
      fragment: { id: "runtime-node-pnpm", kind: "runtime", version: runtime.version },
      evidence: EVIDENCE,
    });
    expect(vfs.read(FRAGMENT_EVIDENCE_MANIFEST_PATH)).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });

  it("rejects unknown fields, traversal, absolute paths, and shell-shaped paths before persistence", () => {
    expect(FragmentEvidenceContractV1Schema.safeParse({ ...EVIDENCE, surprise: true }).success).toBe(false);
    expect(
      FragmentEvidenceContractV1Schema.safeParse({
        ...EVIDENCE,
        testSelector: { path: "../outside.json", format: "json" },
      }).success,
    ).toBe(false);
    expect(
      FragmentEvidenceContractV1Schema.safeParse({
        ...EVIDENCE,
        behaviorManifest: { path: "/tmp/behaviors.json", format: "json" },
      }).success,
    ).toBe(false);
    expect(
      FragmentEvidenceContractV1Schema.safeParse({
        ...EVIDENCE,
        testSelector: { path: "echo pwned", format: "json" },
      }).success,
    ).toBe(false);
  });
});
