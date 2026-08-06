import { describe, expect, it, vi } from "vitest";
import {
  IntegrationNodeMaterializer,
  PgIntegrationNodeMaterializationPersistence,
} from "../src/engine/merge/integrationNodeMaterializer.js";
import { createInMemoryIntegrationNodeMaterializationStore } from "./conformance/fakes/inMemoryMergeQueue.js";
import { InMemoryWorkspaceVcsCore } from "./conformance/fakes/inMemoryWorkspaceVcsCore.js";

const BASE_SHA = "a".repeat(40);
const ANCESTOR_SHA = "b".repeat(40);
const FRONTIER_SHA = "c".repeat(40);

function input() {
  return {
    orgId: "org_eager",
    projectId: "project_eager",
    repoUrl: "https://github.com/owner/repo.git",
    baseBranch: "main",
    baseSha: BASE_SHA,
    members: [
      { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: ANCESTOR_SHA },
      { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: FRONTIER_SHA },
    ],
    localRef: "tanren-local-eager-unit",
    workspacePath: "/scratch/eager",
    purpose: "eager_beam" as const,
  };
}

class EventPool {
  public readonly eventTypes: string[] = [];
  private memberRows: Array<{
    ordinal: number;
    spec_id: string;
    run_id: string;
    branch: string;
    head_sha: string;
    included: boolean;
  }> = [];

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("INSERT INTO integration_nodes")) return { rows: [{ node_id: "node_eager" }], rowCount: 1 };
    // gv-17 dual-write: track member rows so loadAuthoritativeMembers can re-read them.
    if (sql.includes("DELETE FROM integration_node_members")) {
      this.memberRows = [];
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO integration_node_members")) {
      this.memberRows.push({
        ordinal: params[3] as number,
        spec_id: params[4] as string,
        run_id: params[5] as string,
        branch: params[6] as string,
        head_sha: params[7] as string,
        included: true,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM integration_node_members")) {
      return {
        rows: [...this.memberRows].sort((a, b) => a.ordinal - b.ordinal),
        rowCount: this.memberRows.length,
      };
    }
    const eventType = params[5];
    if (eventType === "integration.node.materialized" || eventType === "integration.node.materialization_failed")
      this.eventTypes.push(eventType);
    return { rows: [], rowCount: 1 };
  }
}

describe("IntegrationNodeMaterializer fail-closed assembly", () => {
  it("records an assembly exception and a reported conflict without persisting a node", async () => {
    const missingWorkspace = new InMemoryWorkspaceVcsCore();
    missingWorkspace.seedRemoteRef("main", BASE_SHA);
    const missingStore = createInMemoryIntegrationNodeMaterializationStore();

    await expect(
      new IntegrationNodeMaterializer(missingWorkspace, missingStore).materialize(input()),
    ).resolves.toMatchObject({
      kind: "failed",
      failureCode: "jj_assembly_failed",
    });
    expect(missingStore.nodes).toEqual([]);
    expect(missingStore.events).toEqual([
      expect.objectContaining({
        type: "integration.node.materialization_failed",
        failure: expect.objectContaining({ failureCode: "jj_assembly_failed", runId: "run_frontier" }),
      }),
    ]);

    const conflictWorkspace = new InMemoryWorkspaceVcsCore();
    conflictWorkspace.seedRemoteRef("main", BASE_SHA);
    conflictWorkspace.seedRemoteRef("feature/ancestor", "conflict-ancestor");
    conflictWorkspace.seedRemoteRef("feature/frontier", FRONTIER_SHA);
    const conflictStore = createInMemoryIntegrationNodeMaterializationStore();

    await expect(
      new IntegrationNodeMaterializer(conflictWorkspace, conflictStore).materialize({
        ...input(),
        members: [{ ...input().members[0], headSha: "conflict-ancestor" }, input().members[1]],
      }),
    ).resolves.toMatchObject({ kind: "failed", failureCode: "jj_conflict" });
    expect(conflictStore.nodes).toEqual([]);
  });

  it("persists only a verified assembly and carries the exact pre-persist proof identity", async () => {
    const workspace = new InMemoryWorkspaceVcsCore();
    workspace.seedRemoteRef("main", BASE_SHA);
    workspace.seedRemoteRef("feature/ancestor", ANCESTOR_SHA);
    workspace.seedRemoteRef("feature/frontier", FRONTIER_SHA);
    const store = createInMemoryIntegrationNodeMaterializationStore();
    const beforePersist = vi.fn<() => Promise<{ readonly gateConfigHash: string; readonly policyVersion: string }>>(
      async () => ({ gateConfigHash: "gate_hash", policyVersion: "policy.v1" }),
    );

    await expect(
      new IntegrationNodeMaterializer(workspace, store).materialize({ ...input(), beforePersist }),
    ).resolves.toMatchObject({ kind: "materialized", nodeId: "inode_fake_1", baseSha: BASE_SHA });
    expect(beforePersist).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha: BASE_SHA, members: input().members }),
    );
    expect(store.nodes).toEqual([
      expect.objectContaining({
        purpose: "eager_beam",
        gateConfigHash: "gate_hash",
        policyVersion: "policy.v1",
        runId: "run_frontier",
        specId: "spec_frontier",
      }),
    ]);
  });

  it("emits the materialized and failure evidence through the same org-scoped adapter", async () => {
    const pool = new EventPool();
    const persistence = new PgIntegrationNodeMaterializationPersistence(pool as never);
    const materialization = input();

    await expect(
      persistence.persistMaterialized({
        ...materialization,
        ref: materialization.localRef,
        memberKey: "f".repeat(64),
        headSha: FRONTIER_SHA,
        treeHash: "tree",
        status: "building",
      }),
    ).resolves.toBe("node_eager");
    await persistence.recordMaterializationFailure({
      orgId: "org_eager",
      projectId: "project_eager",
      runId: "run_frontier",
      specId: "spec_frontier",
      memberKey: "f".repeat(64),
      baseSha: BASE_SHA,
      failureCode: "base_sha_moved",
      diagnosticsDigest: `sha256:${"d".repeat(64)}`,
    });

    expect(pool.eventTypes).toEqual(["integration.node.materialized", "integration.node.materialization_failed"]);
  });
});
