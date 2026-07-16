import { describe, expect, it, vi } from "vitest";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import type { QueryClient } from "../src/engine/data/orgScopedDb.js";
import {
  BehaviorCoverageEdgesStore,
  BehaviorCoverageSubjectNotFoundError,
  CoverageIntegrationNodeUnavailableError,
} from "../src/engine/repositories/behaviorCoverageEdges.js";

type QueryResult = { rows: unknown[]; rowCount: number };
type MockQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>;
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const BASE = "0".repeat(40);
const HEAD = "a".repeat(40);
const MEMBER = "b".repeat(64);

function clientWith(query: ReturnType<typeof vi.fn<MockQuery>>): QueryClient {
  return { query } as unknown as QueryClient;
}

describe("BehaviorCoverageEdgesStore", () => {
  it("records one exact-scope append without metadata or legacy spec_behaviors", async () => {
    const query = vi.fn<MockQuery>(async () => ({
      rows: [{ id: "edge-1", edge_kind: "source", target_ref: "src/a.ts" }],
      rowCount: 1,
    }));
    const edge = await BehaviorCoverageEdgesStore.record(
      clientWith(query),
      { orgId: "org-a", projectId: "project-a" },
      { behaviorRevisionId: "br-a" as BehaviorRevisionId, kind: "source", targetRef: "src/a.ts" },
    );
    expect(edge).toMatchObject({ kind: "source", targetRef: "src/a.ts" });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE org_id = $1");
    expect(sql).toContain("project_id = $2");
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

  it("rejects absent/off-scope subjects and dangling dependency targets", async () => {
    const query = vi.fn<MockQuery>(async () => ({ rows: [], rowCount: 0 }));
    await expect(
      BehaviorCoverageEdgesStore.record(
        clientWith(query),
        { orgId: "org-a", projectId: "project-a" },
        { behaviorRevisionId: "br-a" as BehaviorRevisionId, kind: "dependency", targetRef: "missing" },
      ),
    ).rejects.toBeInstanceOf(BehaviorCoverageSubjectNotFoundError);
  });

  it("reads a deterministic graph including immutable revision digests", async () => {
    const rows = [
      {
        behavior_revision_id: "br-a",
        behavior_content_digest: DIGEST_A,
        behavior_title: "behavior a",
        edge_id: "edge-b",
        edge_kind: "component",
        target_ref: "component-a",
      },
      {
        behavior_revision_id: "br-a",
        behavior_content_digest: DIGEST_A,
        behavior_title: "behavior a",
        edge_id: "edge-a",
        edge_kind: "source",
        target_ref: "src/a.ts",
      },
      {
        behavior_revision_id: "br-b",
        behavior_content_digest: `sha256:${"b".repeat(64)}`,
        behavior_title: "behavior b",
        edge_id: null,
        edge_kind: null,
        target_ref: null,
      },
    ];
    const query = vi.fn<MockQuery>(async () => ({ rows, rowCount: rows.length }));
    const result = await BehaviorCoverageEdgesStore.readSnapshot(clientWith(query), {
      orgId: "org-a",
      projectId: "project-a",
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("br.content_digest");
    expect(sql).toContain("edge.org_id = $1");
    expect(sql).toContain("edge.project_id = $2");
    expect(params).toEqual(["org-a", "project-a"]);
    expect(result.behaviors[0]).toEqual({
      behaviorRevisionId: "br-a",
      contentDigest: DIGEST_A,
      title: "behavior a",
      edges: [
        { id: "edge-b", kind: "component", targetRef: "component-a" },
        { id: "edge-a", kind: "source", targetRef: "src/a.ts" },
      ],
    });
  });

  it("resolves exact ready node/head/tree/member binding in the same scope", async () => {
    const query = vi.fn<MockQuery>(async (sql) => {
      if (sql.includes("FROM integration_nodes")) {
        return {
          rows: [
            {
              node_id: "node-a",
              base_sha: BASE,
              head_sha: HEAD,
              tree_hash: "tree-a",
              member_key: MEMBER,
              affected_fingerprint: "",
              status: "ready",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const bound = await BehaviorCoverageEdgesStore.readBoundSnapshot(
      clientWith(query),
      { orgId: "org-a", projectId: "project-a" },
      "node-a",
    );
    expect(bound.binding).toEqual({
      integrationNodeId: "node-a",
      baseSha: BASE,
      preparedHeadSha: HEAD,
      treeHash: "tree-a",
      memberKey: MEMBER,
    });
    expect(bound.authorityFingerprint).toBe("");
    expect(Object.keys(bound)).toEqual(["binding", "authorityFingerprint", "snapshot"]);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("org_id = $1");
    expect(sql).toContain("project_id = $2");
    expect(sql).toContain("status IN ('ready', 'landed')");
    expect(params).toEqual(["org-a", "project-a", "node-a"]);
  });

  it("locks all mutable graph inputs before the publication re-read", async () => {
    const query = vi.fn<MockQuery>(async (sql) => {
      if (sql.startsWith("LOCK TABLE")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM integration_nodes")) {
        return {
          rows: [
            {
              node_id: "node-a",
              base_sha: BASE,
              head_sha: HEAD,
              tree_hash: "tree-a",
              member_key: MEMBER,
              affected_fingerprint: "",
              status: "landed",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    await BehaviorCoverageEdgesStore.lockAndReadBoundSnapshot(
      clientWith(query),
      { orgId: "org-a", projectId: "project-a" },
      "node-a",
    );
    expect(query.mock.calls[0]?.[0]).toBe(
      "LOCK TABLE integration_nodes, behavior_revisions, behavior_coverage_edges IN SHARE MODE",
    );
  });

  it("rejects absent nodes and partial/malformed graph rows fail-closed", async () => {
    const absent = vi.fn<MockQuery>(async () => ({ rows: [], rowCount: 0 }));
    await expect(
      BehaviorCoverageEdgesStore.readBoundSnapshot(
        clientWith(absent),
        { orgId: "org-a", projectId: "project-a" },
        "node-a",
      ),
    ).rejects.toBeInstanceOf(CoverageIntegrationNodeUnavailableError);

    const partial = vi.fn<MockQuery>(async () => ({
      rows: [
        {
          behavior_revision_id: "br-a",
          behavior_content_digest: DIGEST_A,
          behavior_title: "a",
          edge_id: "edge-a",
          edge_kind: null,
          target_ref: "src/a.ts",
        },
      ],
      rowCount: 1,
    }));
    await expect(
      BehaviorCoverageEdgesStore.readSnapshot(clientWith(partial), { orgId: "org-a", projectId: "project-a" }),
    ).rejects.toThrow("partial behavior coverage edge");
  });
});
