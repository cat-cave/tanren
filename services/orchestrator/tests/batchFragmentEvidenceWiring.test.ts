import { describe, expect, it, vi } from "vitest";
import { type CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { buildBatchFragmentEvidenceResolver } from "../src/engine/merge/batchFragmentEvidence.js";
import { batchFragmentEvidenceWiring } from "../src/engine/merge/batchFragmentEvidenceWiring.js";
import {
  fragmentEvidenceContentBytes,
  fragmentEvidenceContentDigest,
} from "../src/engine/templates/fragments/fragmentEvidenceContract.js";
import {
  readComposedFragmentEvidenceManifest,
  readDeclaredFragmentEvidenceReport,
  resolveFragmentEvidenceForBatch,
  type FragmentEvidenceWorkspace,
} from "../src/engine/templates/fragments/resolveFragmentEvidenceForBatch.js";
import { PgVerificationCaptureStore } from "../src/engine/verification/acceptance/renderCaptureStore.js";

const EVIDENCE_BASE = {
  schemaVersion: "fragment_evidence.v1" as const,
  junitReportPath: "reports/junit.xml",
  testSelector: { path: ".tanren/test-selector.json", format: "json" as const },
  behaviorManifest: { path: ".tanren/behavior-manifest.json", format: "json" as const },
};
const DIGEST = fragmentEvidenceContentDigest({ ...EVIDENCE_BASE, contentDigest: `sha256:${"0".repeat(64)}` });
const OTHER_DIGEST = fragmentEvidenceContentDigest({
  ...EVIDENCE_BASE,
  junitReportPath: "reports/other.xml",
  contentDigest: `sha256:${"0".repeat(64)}`,
});
const MANIFEST = {
  schemaVersion: "fragment_evidence_manifest.v1" as const,
  fragment: { id: "runtime-custom", kind: "runtime", version: "1.0.0" },
  evidence: { ...EVIDENCE_BASE, contentDigest: DIGEST },
};
const DEFAULT_SELECTOR = { schemaVersion: "fragment_test_selector.v1", tests: ["tests/changed.test.ts"] };
const DEFAULT_BEHAVIORS = {
  schemaVersion: "fragment_behavior_manifest.v1",
  behaviors: ["a user sees the changed result"],
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

function evidenceFiles(selector = DEFAULT_SELECTOR, behaviors = DEFAULT_BEHAVIORS): Record<string, string> {
  return {
    ".tanren/evidence-contract.json": JSON.stringify(MANIFEST),
    ".tanren/test-selector.json": JSON.stringify(selector),
    ".tanren/behavior-manifest.json": JSON.stringify(behaviors),
  };
}

function rows(values: readonly Record<string, unknown>[]) {
  return { rows: [...values], rowCount: values.length };
}

class BatchEvidencePool {
  constructor(
    private readonly fragments: readonly Record<string, unknown>[],
    private readonly artifacts: readonly Record<string, unknown>[],
  ) {}

  async connect() {
    return {
      query: async (sql: string) => {
        const statement = sql.replaceAll(/\s+/gu, " ").trim();
        if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") return rows([]);
        if (statement.startsWith("SET LOCAL app.current_org_id")) return rows([]);
        if (statement.includes("FROM fragments")) return rows(this.fragments);
        if (statement.includes("FROM verification_artifacts")) return rows(this.artifacts);
        throw new Error(`unexpected query: ${statement}`);
      },
      release() {},
    } as never;
  }

  asPgPool() {
    return this as never;
  }
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
      workspace(evidenceFiles()),
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

  it("fails closed for absent, malformed, stale, duplicate, invalid, and digest-mismatched evidence", async () => {
    await expect(
      resolveFragmentEvidenceForBatch(workspace({}), FRAGMENT, request(["tests/changed.test.ts"])),
    ).resolves.toEqual({
      kind: "fallback",
      reason: "manifest_absent",
    });
    await expect(
      resolveFragmentEvidenceForBatch(
        workspace({ ".tanren/evidence-contract.json": "{}" }),
        FRAGMENT,
        request(["tests/changed.test.ts"]),
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "manifest_malformed" });
    await expect(
      resolveFragmentEvidenceForBatch(workspace(evidenceFiles()), undefined, request(["tests/changed.test.ts"])),
    ).resolves.toEqual({ kind: "fallback", reason: "fragment_absent" });
    await expect(
      resolveFragmentEvidenceForBatch(
        workspace(evidenceFiles()),
        { ...FRAGMENT, evidence: { ...FRAGMENT.evidence, contentDigest: OTHER_DIGEST } },
        request(["tests/changed.test.ts"]),
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "fragment_mismatch" });
    await expect(
      resolveFragmentEvidenceForBatch(
        workspace(evidenceFiles({ schemaVersion: "fragment_test_selector.v1", tests: ["src/not-a-test.ts"] })),
        FRAGMENT,
        request(["tests/changed.test.ts"]),
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "selector_malformed" });
    await expect(
      resolveFragmentEvidenceForBatch(
        workspace(
          evidenceFiles(undefined, {
            schemaVersion: "fragment_behavior_manifest.v1",
            behaviors: ["same behavior", "same behavior"],
          }),
        ),
        FRAGMENT,
        request(["tests/changed.test.ts"]),
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "behavior_manifest_malformed" });
    const { [".tanren/behavior-manifest.json"]: _behavior, ...withoutBehavior } = evidenceFiles();
    await expect(
      resolveFragmentEvidenceForBatch(workspace(withoutBehavior), FRAGMENT, request(["tests/changed.test.ts"])),
    ).resolves.toEqual({ kind: "fallback", reason: "behavior_manifest_unreadable" });
    await expect(resolveFragmentEvidenceForBatch(workspace(evidenceFiles()), FRAGMENT, request([]))).resolves.toEqual({
      kind: "fallback",
      reason: "changed_tests_empty",
    });
    await expect(
      resolveFragmentEvidenceForBatch(workspace(evidenceFiles()), FRAGMENT, request(["scripts/build.ts"])),
    ).resolves.toEqual({ kind: "fallback", reason: "changed_tests_invalid" });
    await expect(
      resolveFragmentEvidenceForBatch(
        workspace(evidenceFiles()),
        FRAGMENT,
        request(["tests/changed.test.ts", "tests/changed.test.ts"]),
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "selector_set_mismatch" });
    await expect(
      resolveFragmentEvidenceForBatch(workspace(evidenceFiles()), FRAGMENT, {
        ...request(["tests/changed.test.ts"]),
        capturedArtifact: { casDigest: OTHER_DIGEST, proofUnitDigest: null },
      }),
    ).resolves.toEqual({ kind: "fallback", reason: "artifact_digest_mismatch" });
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

  it("loads the selected fragment and artifact through a DB-free scoped-pool fake", async () => {
    const pool = new BatchEvidencePool(
      [{ kind: "runtime", label: "custom", version: "1.0.0", contract: { evidence: MANIFEST.evidence } }],
      [{ cas_digest: DIGEST, proof_unit_digest: null }],
    );
    const files = workspace(evidenceFiles());
    const resolver = buildBatchFragmentEvidenceResolver(pool.asPgPool());

    const result = await resolver({ target: {} as never, workspacePath: "/workspace" } as never, {
      orgId: "org_mq12",
      projectId: "project_mq12",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      treeHash: "tree-1",
      memberSetHash: "member-1",
      localRef: "@",
      ssh: {
        async run(target, command) {
          if (command.command.startsWith("jj diff")) {
            return { exitCode: 0, stdout: "README.md\ntests/changed.test.ts\n", stderr: "" };
          }
          return files.ssh.run(target, command);
        },
      },
    });

    expect(result.kind).toBe("selected");
    expect(result).toMatchObject({ artifactDigest: DIGEST, selector: { tests: ["tests/changed.test.ts"] } });
  });

  it("keeps both production ports DB-free and skips recapture once immutable evidence already exists", async () => {
    const pool = new BatchEvidencePool(
      [{ kind: "runtime", label: "custom", version: "1.0.0", contract: { evidence: MANIFEST.evidence } }],
      [{ cas_digest: DIGEST, proof_unit_digest: null }],
    );
    const files = workspace(evidenceFiles());
    const ports = batchFragmentEvidenceWiring(pool.asPgPool());
    const live = { target: {} as never, workspacePath: "/workspace" } as never;
    const ssh: CommandSubstrate = {
      async run(target, command) {
        if (command.command.startsWith("jj diff"))
          return { exitCode: 0, stdout: "tests/changed.test.ts\n", stderr: "" };
        return files.ssh.run(target, command);
      },
    };
    const batchRequest = {
      orgId: "org_mq12",
      projectId: "project_mq12",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      treeHash: "tree-1",
      memberSetHash: "member-1",
      localRef: "@",
      ssh,
    };

    await expect(ports.resolveFragmentEvidence(live, batchRequest)).resolves.toMatchObject({ kind: "selected" });
    await expect(ports.captureFragmentEvidence(live, batchRequest)).resolves.toBeUndefined();
  });

  it("captures only an absent immutable contract after its report exists, never as a command", async () => {
    const pool = new BatchEvidencePool(
      [{ kind: "runtime", label: "custom", version: "1.0.0", contract: { evidence: MANIFEST.evidence } }],
      [],
    );
    const files = workspace({ ...evidenceFiles(), "reports/junit.xml": "<testsuite />" });
    const capture = vi.spyOn(PgVerificationCaptureStore.prototype, "capture").mockResolvedValue({} as never);
    const live = { target: {} as never, workspacePath: "/workspace" } as never;
    const ssh: CommandSubstrate = {
      async run(target, command) {
        if (command.command.startsWith("jj diff"))
          return { exitCode: 0, stdout: "tests/changed.test.ts\n", stderr: "" };
        return files.ssh.run(target, command);
      },
    };
    const batchRequest = {
      orgId: "org_mq12",
      projectId: "project_mq12",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      treeHash: "tree-1",
      memberSetHash: "member-1",
      localRef: "@",
      ssh,
    };

    try {
      await expect(buildBatchFragmentEvidenceResolver(pool.asPgPool())(live, batchRequest)).resolves.toEqual({
        kind: "fallback",
        reason: "artifact_absent",
      });
      await expect(
        batchFragmentEvidenceWiring(pool.asPgPool()).captureFragmentEvidence(live, batchRequest),
      ).resolves.toBeUndefined();
      expect(capture).toHaveBeenCalledWith({
        orgId: "org_mq12",
        projectId: "project_mq12",
        kind: "fragment_evidence_contract",
        mediaType: "application/vnd.tanren.fragment-evidence-contract+json",
        bytes: fragmentEvidenceContentBytes(MANIFEST.evidence),
        expectedDigest: DIGEST,
        redactionClass: "sensitive",
      });
    } finally {
      capture.mockRestore();
    }
  });

  it("fails closed when the production loader sees malformed, mismatched, or invalid persisted evidence rows", async () => {
    const resolve = async (
      pool: BatchEvidencePool,
      manifest = MANIFEST,
    ): Promise<Awaited<ReturnType<ReturnType<typeof buildBatchFragmentEvidenceResolver>>>> => {
      const files = workspace({ ...evidenceFiles(), ".tanren/evidence-contract.json": JSON.stringify(manifest) });
      return buildBatchFragmentEvidenceResolver(pool.asPgPool())(
        { target: {} as never, workspacePath: "/workspace" } as never,
        {
          orgId: "org_mq12",
          projectId: "project_mq12",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          treeHash: "tree-1",
          memberSetHash: "member-1",
          localRef: "@",
          ssh: {
            async run(target, command) {
              if (command.command.startsWith("jj diff")) {
                return { exitCode: 0, stdout: "tests/changed.test.ts\n", stderr: "" };
              }
              return files.ssh.run(target, command);
            },
          },
        },
      );
    };
    const validFragment = [
      { kind: "runtime", label: "custom", version: "1.0.0", contract: { evidence: MANIFEST.evidence } },
    ];

    await expect(
      resolve(new BatchEvidencePool(validFragment, []), {
        ...MANIFEST,
        fragment: { ...MANIFEST.fragment, id: "addon-custom" },
      }),
    ).resolves.toEqual({ kind: "fallback", reason: "fragment_absent" });
    await expect(resolve(new BatchEvidencePool([], []))).resolves.toEqual({
      kind: "fallback",
      reason: "fragment_absent",
    });
    await expect(resolve(new BatchEvidencePool([{ kind: "runtime" }], []))).resolves.toEqual({
      kind: "fallback",
      reason: "fragment_absent",
    });
    await expect(
      resolve(
        new BatchEvidencePool(
          [{ ...validFragment[0], contract: { evidence: { ...MANIFEST.evidence, contentDigest: OTHER_DIGEST } } }],
          [],
        ),
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "fragment_absent" });
    await expect(
      resolve(new BatchEvidencePool(validFragment, [{ cas_digest: "not-a-digest", proof_unit_digest: null }])),
    ).resolves.toEqual({
      kind: "fallback",
      reason: "artifact_absent",
    });
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
