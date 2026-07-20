import { describe, expect, it } from "vitest";
import { type CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { buildBatchFragmentEvidenceResolver } from "../src/engine/merge/batchFragmentEvidence.js";
import { fragmentEvidenceContentDigest } from "../src/engine/templates/fragments/fragmentEvidenceContract.js";
import {
  readComposedFragmentEvidenceManifest,
  readDeclaredFragmentEvidenceReport,
  resolveFragmentEvidenceForBatch,
  type FragmentEvidenceWorkspace,
} from "../src/engine/templates/fragments/resolveFragmentEvidenceForBatch.js";

const EVIDENCE_BASE = {
  schemaVersion: "fragment_evidence.v1" as const,
  junitReportPath: "reports/junit.xml",
  testSelector: { path: ".tanren/test-selector.json", format: "json" as const },
  behaviorManifest: { path: ".tanren/behavior-manifest.json", format: "json" as const },
};
const DIGEST = fragmentEvidenceContentDigest({ ...EVIDENCE_BASE, contentDigest: `sha256:${"0".repeat(64)}` });
const MANIFEST = {
  schemaVersion: "fragment_evidence_manifest.v1" as const,
  fragment: { id: "runtime-custom", kind: "runtime", version: "1.0.0" },
  evidence: { ...EVIDENCE_BASE, contentDigest: DIGEST },
};

function workspace(files: Readonly<Record<string, string>>): FragmentEvidenceWorkspace {
  const ssh: CommandSubstrate = {
    async run(_target, command) {
      const path = Object.keys(files).find((candidate) => command.command.includes(candidate));
      return path === undefined
        ? { exitCode: 3, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: files[path] ?? "", stderr: "" };
    },
  };
  return { ssh, target: {} as never, workspacePath: "/workspace" };
}

function request(changedTestPaths: readonly string[], captured = true) {
  return {
    workspaceIdentity: {
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      treeHash: "tree-1",
      memberSetHash: "member-1",
    },
    changedTestPaths,
    capturedArtifact: captured ? { casDigest: DIGEST, proofUnitDigest: null as const } : undefined,
  };
}

const FRAGMENT = {
  id: MANIFEST.fragment.id,
  kind: MANIFEST.fragment.kind,
  version: MANIFEST.fragment.version,
  evidence: MANIFEST.evidence,
};

describe("resolveFragmentEvidenceForBatch", () => {
  it("production adapter invokes the resolver and returns a typed fallback when the composed manifest is absent", async () => {
    const resolver = buildBatchFragmentEvidenceResolver({} as never);
    const result = await resolver({ target: {} as never, workspacePath: "/workspace" } as never, {
      orgId: "org_mq12",
      projectId: "project_mq12",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      treeHash: "tree-1",
      memberSetHash: "member-1",
      localRef: "@",
      ssh: {
        async run(_target, command) {
          return command.command.startsWith("jj diff")
            ? { exitCode: 0, stdout: "tests/changed.test.ts\n", stderr: "" }
            : { exitCode: 3, stdout: "", stderr: "" };
        },
      },
    });

    expect(result).toEqual({ kind: "fallback", reason: "manifest_absent" });
  });

  it("selects only an exact changed-test set with a matching immutable artifact, then exposes no executable command", async () => {
    const result = await resolveFragmentEvidenceForBatch(
      workspace({
        ".tanren/evidence-contract.json": JSON.stringify(MANIFEST),
        ".tanren/test-selector.json": JSON.stringify({
          schemaVersion: "fragment_test_selector.v1",
          tests: ["tests/changed.test.ts"],
        }),
        ".tanren/behavior-manifest.json": JSON.stringify({
          schemaVersion: "fragment_behavior_manifest.v1",
          behaviors: ["a user sees the changed result"],
        }),
      }),
      FRAGMENT,
      request(["tests/changed.test.ts"]),
    );
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.selector).toEqual({
      path: ".tanren/test-selector.json",
      format: "json",
      tests: ["tests/changed.test.ts"],
    });
    expect(result.artifactDigest).toBe(DIGEST);
    expect(result.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect("command" in result.selector).toBe(false);
  });

  it("negative control: a changed test excluded from the claimed selector falls back to the full pre-merge gate", async () => {
    const result = await resolveFragmentEvidenceForBatch(
      workspace({
        ".tanren/evidence-contract.json": JSON.stringify(MANIFEST),
        ".tanren/test-selector.json": JSON.stringify({
          schemaVersion: "fragment_test_selector.v1",
          tests: ["tests/selected.test.ts"],
        }),
        ".tanren/behavior-manifest.json": JSON.stringify({
          schemaVersion: "fragment_behavior_manifest.v1",
          behaviors: ["a user sees the changed result"],
        }),
      }),
      FRAGMENT,
      request(["tests/unselected.test.ts"]),
    );
    expect(result).toEqual({ kind: "fallback", reason: "selector_set_mismatch" });
  });

  it("falls back when the report artifact was never captured; it never treats manifest presence as a pass", async () => {
    const result = await resolveFragmentEvidenceForBatch(
      workspace({
        ".tanren/evidence-contract.json": JSON.stringify(MANIFEST),
        ".tanren/test-selector.json": JSON.stringify({
          schemaVersion: "fragment_test_selector.v1",
          tests: ["tests/changed.test.ts"],
        }),
        ".tanren/behavior-manifest.json": JSON.stringify({
          schemaVersion: "fragment_behavior_manifest.v1",
          behaviors: ["a user sees the changed result"],
        }),
      }),
      FRAGMENT,
      request(["tests/changed.test.ts"], false),
    );
    expect(result).toEqual({ kind: "fallback", reason: "artifact_absent" });
  });

  it("treats absent, unreadable, and malformed manifest/report files as evidence failure, never as presence", async () => {
    expect(await readComposedFragmentEvidenceManifest(workspace({}))).toBe("manifest_absent");
    expect(
      await readComposedFragmentEvidenceManifest({
        ...workspace({}),
        ssh: {
          async run() {
            return { exitCode: 1, stdout: "", stderr: "read failed" };
          },
        },
      }),
    ).toBe("manifest_unreadable");
    expect(await readComposedFragmentEvidenceManifest(workspace({ ".tanren/evidence-contract.json": "{" }))).toBe(
      "manifest_malformed",
    );
    await expect(
      readDeclaredFragmentEvidenceReport(workspace({ "reports/junit.xml": "<testsuite />" }), MANIFEST.evidence),
    ).resolves.toEqual(new TextEncoder().encode("<testsuite />"));
    await expect(readDeclaredFragmentEvidenceReport(workspace({}), MANIFEST.evidence)).resolves.toBeUndefined();
  });

  it("fails closed before selection for invalid identity, a mismatched fragment, or an unreadable selector", async () => {
    const validFiles = {
      ".tanren/evidence-contract.json": JSON.stringify(MANIFEST),
      ".tanren/test-selector.json": JSON.stringify({
        schemaVersion: "fragment_test_selector.v1",
        tests: ["tests/changed.test.ts"],
      }),
      ".tanren/behavior-manifest.json": JSON.stringify({
        schemaVersion: "fragment_behavior_manifest.v1",
        behaviors: ["a user sees the changed result"],
      }),
    };
    await expect(
      resolveFragmentEvidenceForBatch(workspace(validFiles), FRAGMENT, {
        ...request(["tests/changed.test.ts"]),
        workspaceIdentity: { ...request(["tests/changed.test.ts"]).workspaceIdentity, baseSha: " " },
      }),
    ).resolves.toEqual({ kind: "fallback", reason: "workspace_identity_invalid" });
    await expect(
      resolveFragmentEvidenceForBatch(
        workspace(validFiles),
        { ...FRAGMENT, id: "runtime-other" },
        request(["tests/changed.test.ts"]),
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "fragment_mismatch" });
    const { [".tanren/test-selector.json"]: _selector, ...withoutSelector } = validFiles;
    await expect(
      resolveFragmentEvidenceForBatch(workspace(withoutSelector), FRAGMENT, request(["tests/changed.test.ts"])),
    ).resolves.toEqual({ kind: "fallback", reason: "selector_unreadable" });
  });
});
