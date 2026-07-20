import { describe, expect, it } from "vitest";
import { fragmentEvidenceContentDigest } from "../src/engine/templates/fragments/fragmentEvidenceContract.js";
import {
  readComposedFragmentEvidenceManifest,
  resolveFragmentEvidenceForBatch,
  type FragmentEvidenceWorkspace,
} from "../src/engine/templates/fragments/resolveFragmentEvidenceForBatch.js";

const BASE = {
  schemaVersion: "fragment_evidence.v1" as const,
  junitReportPath: "reports/junit.xml",
  testSelector: { path: ".tanren/selector.json", format: "json" as const },
  behaviorManifest: { path: ".tanren/behavior.json", format: "json" as const },
};
const EVIDENCE = {
  ...BASE,
  contentDigest: fragmentEvidenceContentDigest({ ...BASE, contentDigest: `sha256:${"0".repeat(64)}` }),
};
const MANIFEST = {
  schemaVersion: "fragment_evidence_manifest.v1" as const,
  fragment: { id: "runtime-mq12", kind: "runtime", version: "1.0.0" },
  evidence: EVIDENCE,
};
const FRAGMENT = { ...MANIFEST.fragment, evidence: EVIDENCE };

function workspace(files: Record<string, string>): FragmentEvidenceWorkspace {
  return {
    target: {} as never,
    workspacePath: "/workspace",
    ssh: {
      async run(_target, command) {
        const path = Object.keys(files).find((candidate) => command.command.includes(candidate));
        return path === undefined
          ? { exitCode: 3, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: files[path], stderr: "" };
      },
    },
  };
}

function evidenceFiles(selectorTests: readonly string[]) {
  return {
    ".tanren/evidence-contract.json": JSON.stringify(MANIFEST),
    ".tanren/selector.json": JSON.stringify({ schemaVersion: "fragment_test_selector.v1", tests: selectorTests }),
    ".tanren/behavior.json": JSON.stringify({
      schemaVersion: "fragment_behavior_manifest.v1",
      behaviors: ["z behavior", "a behavior"],
    }),
  };
}

function request(changedTestPaths: readonly string[]) {
  return {
    workspaceIdentity: { baseSha: "a".repeat(40), headSha: "b".repeat(40), treeHash: "tree", memberSetHash: "members" },
    changedTestPaths,
    capturedArtifact: { casDigest: EVIDENCE.contentDigest, proofUnitDigest: null as const },
  };
}

describe("mq-12 fragment evidence resolver edge cases", () => {
  it("canonicalizes an exact unordered claim but fails closed when a selector omits a changed test", async () => {
    const selected = await resolveFragmentEvidenceForBatch(
      workspace(evidenceFiles(["tests/z.test.ts", "tests/a.test.ts"])),
      FRAGMENT,
      request(["tests/a.test.ts", "tests/z.test.ts"]),
    );
    expect(selected).toMatchObject({
      kind: "selected",
      selector: { tests: ["tests/a.test.ts", "tests/z.test.ts"] },
      behaviorManifest: { behaviors: ["a behavior", "z behavior"] },
    });

    await expect(
      resolveFragmentEvidenceForBatch(
        workspace(evidenceFiles(["tests/a.test.ts", "tests/z.test.ts"])),
        FRAGMENT,
        request(["tests/a.test.ts"]),
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "selector_set_mismatch" });
  });

  it("treats a stalled manifest read as unavailable evidence rather than as an empty contract", async () => {
    const stalled: FragmentEvidenceWorkspace = {
      ...workspace({}),
      ssh: {
        async run() {
          return { exitCode: 0, stdout: "", stderr: "", stalled: true };
        },
      },
    };

    await expect(readComposedFragmentEvidenceManifest(stalled)).resolves.toBe("manifest_unreadable");
  });
});
