import { describe, expect, it } from "vitest";
import { createEagerBeamPlan, eagerBeamPlanV1Schema } from "../src/engine/contracts/eagerBeamPlan.js";
import { proofReuseKey } from "../src/engine/contracts/integrationNodes.js";
import { selectEagerBeamCandidates } from "../src/engine/merge/eagerIntegrationBeamPlanner.js";
import { IntegrationNodeMaterializer } from "../src/engine/merge/integrationNodeMaterializer.js";
import { createInMemoryIntegrationNodeMaterializationStore } from "./conformance/fakes/inMemoryMergeQueue.js";
import { InMemoryWorkspaceVcsCore } from "./conformance/fakes/inMemoryWorkspaceVcsCore.js";

const baseSha = "a".repeat(40);
const ancestorSha = "b".repeat(40);
const frontierSha = "c".repeat(40);

function plan() {
  return createEagerBeamPlan({
    beamWidth: 2,
    rank: 1,
    orgId: "org_eager",
    projectId: "project_eager",
    frontierRunId: "run_frontier",
    frontierSpecId: "spec_frontier",
    baseBranch: "main",
    baseSha,
    ancestorStack: [
      { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: ancestorSha },
    ],
    frontier: { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: frontierSha },
    proofReuseInput: {
      memberKey: "0".repeat(64),
      gateConfigHash: "d".repeat(64),
      policyVersion: "1",
      runnerImage: "runner@sha256:abc",
      appEnvHash: "e".repeat(64),
      quarantineVersion: "active_quarantine.v1:known",
    },
  });
}

describe("EagerBeamPlanV1", () => {
  it("binds the exact base, ordered members, ancestor stack, and six proof inputs", () => {
    const value = plan();
    expect(value.expectedMemberKey).toBe(value.proofReuseInput.memberKey);
    expect(proofReuseKey(value.proofReuseInput)).toMatch(/^[0-9a-f]{64}$/u);
    expect(value.members.map((member) => member.headSha)).toEqual([ancestorSha, frontierSha]);
  });

  it("rejects a stale member SHA and a blank confirmation field instead of creating a reusable plan", () => {
    const value = plan();
    expect(
      eagerBeamPlanV1Schema.safeParse({
        ...value,
        members: [...value.members.slice(0, 1), { ...value.members[1], headSha: "f".repeat(40) }],
      }).success,
    ).toBe(false);
    expect(
      eagerBeamPlanV1Schema.safeParse({
        ...value,
        proofReuseInput: { ...value.proofReuseInput, policyVersion: "   " },
      }).success,
    ).toBe(false);
  });
});

describe("selectEagerBeamCandidates", () => {
  it("is deterministic and bounded while leaving non-selected work to the normal queue", () => {
    const candidates = [
      {
        runId: "run_c",
        specId: "spec_c",
        priority: "P1",
        createdAt: "2026-01-01T00:00:00.000Z",
        branch: "c",
        ancestorStack: [],
      },
      {
        runId: "run_b",
        specId: "spec_b",
        priority: "P0",
        createdAt: "2026-01-02T00:00:00.000Z",
        branch: "b",
        ancestorStack: [],
      },
      {
        runId: "run_a",
        specId: "spec_a",
        priority: "P0",
        createdAt: "2026-01-01T00:00:00.000Z",
        branch: "a",
        ancestorStack: [],
      },
    ] as const;
    expect(selectEagerBeamCandidates(candidates, 2).map((candidate) => candidate.runId)).toEqual(["run_a", "run_b"]);
    expect(candidates.map((candidate) => candidate.runId)).toContain("run_c");
  });
});

describe("EAGER materialization preflight", () => {
  it("rejects an unresolved proof identity before persisting an integration node", async () => {
    const workspace = new InMemoryWorkspaceVcsCore();
    workspace.seedRemoteRef("main", baseSha);
    workspace.seedRemoteRef("feature/ancestor", ancestorSha);
    workspace.seedRemoteRef("feature/frontier", frontierSha);
    const persisted = createInMemoryIntegrationNodeMaterializationStore();
    const materializer = new IntegrationNodeMaterializer(workspace, persisted);

    await expect(
      materializer.materialize({
        orgId: "org_eager",
        projectId: "project_eager",
        repoUrl: "https://example.test/eager.git",
        baseBranch: "main",
        baseSha,
        members: [
          { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: ancestorSha },
          { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: frontierSha },
        ],
        localRef: "tanren-local-eager-test",
        workspacePath: "/scratch/eager",
        purpose: "eager_beam",
        beforePersist: async () => {
          throw new Error("eager proof-reuse identity is unresolved");
        },
      }),
    ).rejects.toThrow("unresolved");
    expect(persisted.nodes).toEqual([]);
    expect(persisted.events).toEqual([]);
  });
});
