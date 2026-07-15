import { describe, expect, it, vi } from "vitest";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import type { QueryClient } from "../src/engine/data/orgScopedDb.js";
import {
  BehaviorCoverageEdgesStore,
  BehaviorCoverageSubjectNotFoundError,
} from "../src/engine/repositories/behaviorCoverageEdges.js";
import { systemActor } from "../src/engine/state/actor.js";

type MockQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

function clientWith(rows: unknown[]): { client: QueryClient; query: ReturnType<typeof vi.fn<MockQuery>> } {
  const query = vi.fn<MockQuery>(async () => ({ rows, rowCount: rows.length }));
  return { client: { query } as unknown as QueryClient, query };
}

describe("BehaviorCoverageEdgesStore", () => {
  it("records an org/project-bound edge without consulting spec_behaviors or metadata", async () => {
    const { client, query } = clientWith([{ id: "edge-1", edge_kind: "source", target_ref: "src/a.ts" }]);

    const edge = await BehaviorCoverageEdgesStore.record(
      client,
      { orgId: "org-a", projectId: "project-a" },
      {
        behaviorRevisionId: "br-a" as BehaviorRevisionId,
        kind: "source",
        targetRef: "src/a.ts",
      },
      systemActor,
    );

    expect(edge).toMatchObject({ kind: "source", targetRef: "src/a.ts" });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("br.org_id = $1");
    expect(sql).toContain("project_id = $2");
    expect(sql).toContain("behavior_coverage_edges");
    expect(sql).not.toContain("spec_behaviors");
    expect(sql).not.toContain("metadata");
    expect(params).toEqual([
      "org-a",
      "project-a",
      expect.stringMatching(/^coverage_edge_/u),
      "br-a",
      "source",
      "src/a.ts",
    ]);
  });

  it("rejects an absent/off-scope subject or dangling dependency target", async () => {
    const { client } = clientWith([]);

    await expect(
      BehaviorCoverageEdgesStore.record(
        client,
        { orgId: "org-a", projectId: "project-a" },
        {
          behaviorRevisionId: "br-a" as BehaviorRevisionId,
          kind: "dependency",
          targetRef: "missing-revision",
        },
        systemActor,
      ),
    ).rejects.toBeInstanceOf(BehaviorCoverageSubjectNotFoundError);
  });

  it("reads one deterministic MVCC graph snapshot with explicit org and project predicates", async () => {
    const { client, query } = clientWith([
      {
        behavior_revision_id: "br-a",
        behavior_title: "behavior a",
        edge_id: "edge-a",
        edge_kind: "source",
        target_ref: "src/a.ts",
      },
      {
        behavior_revision_id: "br-a",
        behavior_title: "behavior a",
        edge_id: "edge-b",
        edge_kind: "component",
        target_ref: "component-a",
      },
      {
        behavior_revision_id: "br-b",
        behavior_title: "behavior b",
        edge_id: null,
        edge_kind: null,
        target_ref: null,
      },
    ]);

    const result = await BehaviorCoverageEdgesStore.readSnapshot(
      client,
      { orgId: "org-a", projectId: "project-a" },
      systemActor,
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("edge.org_id = $1");
    expect(sql).toContain("edge.project_id = $2");
    expect(sql).toContain("br.org_id = $1");
    expect(params).toEqual(["org-a", "project-a"]);
    expect(result).toEqual({
      orgId: "org-a",
      projectId: "project-a",
      behaviors: [
        {
          behaviorRevisionId: "br-a",
          title: "behavior a",
          edges: [
            { id: "edge-a", kind: "source", targetRef: "src/a.ts" },
            { id: "edge-b", kind: "component", targetRef: "component-a" },
          ],
        },
        { behaviorRevisionId: "br-b", title: "behavior b", edges: [] },
      ],
    });
  });

  it("rejects a partial joined edge row instead of treating it as uncovered", async () => {
    const { client } = clientWith([
      {
        behavior_revision_id: "br-a",
        behavior_title: "behavior a",
        edge_id: "edge-a",
        edge_kind: null,
        target_ref: "src/a.ts",
      },
    ]);

    await expect(
      BehaviorCoverageEdgesStore.readSnapshot(client, { orgId: "org-a", projectId: "project-a" }, systemActor),
    ).rejects.toThrow("partial behavior_coverage_edges row");
  });

  it("rejects a malformed persisted edge kind at the SQL boundary", async () => {
    const { client } = clientWith([
      {
        behavior_revision_id: "br-a",
        behavior_title: "behavior a",
        edge_id: "edge-a",
        edge_kind: "metadata",
        target_ref: "src/a.ts",
      },
    ]);

    await expect(
      BehaviorCoverageEdgesStore.readSnapshot(client, { orgId: "org-a", projectId: "project-a" }, systemActor),
    ).rejects.toThrow(/invalid|expected|option/iu);
  });
});
