import { describe, expect, it } from "vitest";
import { composeTemplate } from "../src/engine/templates/fragments/compose.js";
import { processFragmentEvidenceContract } from "../src/engine/templates/fragments/composeFragmentEvidence.js";
import {
  FragmentEvidenceContractV1Schema,
  FragmentEvidenceManifestV1Schema,
  fragmentEvidenceContentDigest,
  FRAGMENT_EVIDENCE_MANIFEST_PATH,
} from "../src/engine/templates/fragments/fragmentEvidenceContract.js";
import { loadFragmentLibraryForTests } from "../src/engine/templates/fragments/library/index.js";
import { type Fragment, VirtualFileSystem } from "../src/engine/templates/fragments/types.js";

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

function fragmentWithEvidence(overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: "runtime-evidence",
    version: "1.0.0",
    kind: "runtime",
    contract: { reportPath: EVIDENCE.junitReportPath, evidence: EVIDENCE },
    async apply() {},
    ...overrides,
  };
}

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

  it("rejects every non-declarative or stale contract shape before persistence", () => {
    const malformed = [
      { ...EVIDENCE, surprise: true },
      { ...EVIDENCE, testSelector: { path: "../outside.json", format: "json" } },
      { ...EVIDENCE, behaviorManifest: { path: "/tmp/behaviors.json", format: "json" } },
      { ...EVIDENCE, testSelector: { path: "echo pwned", format: "json" } },
      { ...EVIDENCE, behaviorManifest: { path: "behaviors.json", format: "yaml" } },
      { ...EVIDENCE, contentDigest: `sha256:${"f".repeat(64)}` },
    ];

    for (const contract of malformed) expect(FragmentEvidenceContractV1Schema.safeParse(contract).success).toBe(false);
  });

  it("does not emit a manifest for no evidence and rejects conflicting or mismatched declarations", () => {
    const vfs = new VirtualFileSystem();
    processFragmentEvidenceContract(vfs, [fragmentWithEvidence({ contract: {} })]);
    expect(vfs.has(FRAGMENT_EVIDENCE_MANIFEST_PATH)).toBe(false);

    expect(() => processFragmentEvidenceContract(vfs, [fragmentWithEvidence(), fragmentWithEvidence()])).toThrow(
      /exactly one selected fragment/u,
    );
    expect(() =>
      processFragmentEvidenceContract(vfs, [
        fragmentWithEvidence({ contract: { reportPath: "reports/other.xml", evidence: EVIDENCE } }),
      ]),
    ).toThrow(/junitReportPath must exactly match/u);
  });
});
