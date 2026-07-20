import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeQueueSnapshot } from "../src/engine/contracts/mergeCoordinator.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const hostState = {
  fetchRef:
    vi.fn<
      (input: {
        readonly repo: { readonly owner: string; readonly name: string };
        readonly remoteBranch: string;
      }) => Promise<string | undefined>
    >(),
  readDiff:
    vi.fn<
      (repo: { readonly owner: string; readonly name: string }, baseSha: string, headSha: string) => Promise<string>
    >(),
};

import { PgIntegrationGraphSchedulerFacts } from "../src/engine/merge/integrationGraphSchedulerPg.js";

class SchedulerFactsPool {
  public updates: Array<{ partitionId: string; fingerprint: string }> = [];
  public malformedLease = false;
  public branchChangedAfterRead = false;

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_schedule" }], rowCount: 1 };
    if (sql.includes("SELECT p.org_id")) {
      return {
        rows: [
          {
            org_id: "org_schedule",
            repo_url: "https://github.com/owner/repo.git",
            default_branch: "main",
            project_config: {},
            org_config: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM merge_queue mq") && sql.includes("JOIN runs r")) {
      return {
        rows: [
          {
            queue_id: "queue_a",
            run_id: "run_a",
            spec_id: "spec_a",
            branch: this.branchChangedAfterRead && sql.includes("FOR UPDATE") ? "feature/other" : "feature/a",
            partition_id: null,
            scope_fingerprint: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("LEFT JOIN merge_queue_partitions")) {
      return this.malformedLease
        ? {
            rows: [{ partition_id: null, lease_owner: "owner", lease_epoch: 1, generation: null, scope_key: null }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM integration_nodes")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO merge_queue_partitions")) {
      return {
        rows: [
          {
            id: "partition_semantic",
            scope_key: semanticFingerprint("migration:database"),
            mode: "scoped",
            generation: 0,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE merge_queue")) {
      this.updates.push({ partitionId: String(values[3]), fingerprint: String(values[4]) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }

  public asPgPool(): never {
    return this as never;
  }
}

function snapshot(): MergeQueueSnapshot {
  return {
    projectId: "project_schedule",
    entries: [
      {
        orgId: "org_schedule",
        projectId: "project_schedule",
        queueId: "queue_a",
        runId: "run_a",
        specId: "spec_a",
        prUrl: "https://github.com/owner/repo/pull/1",
        prNumber: 1,
        dependsOn: [],
        priority: "P1",
        orderKey: 1,
      },
    ],
    mergedSpecIds: new Set(),
    mergingInFlight: false,
  };
}

function subject(pool: SchedulerFactsPool): PgIntegrationGraphSchedulerFacts {
  return new PgIntegrationGraphSchedulerFacts({
    pool: pool.asPgPool(),
    buildCodeHost: async () => ({
      host: { fetchRef: hostState.fetchRef, readDiff: hostState.readDiff },
      repo: { owner: "owner", name: "repo" },
    }),
  });
}

describe("PgIntegrationGraphSchedulerFacts", () => {
  beforeEach(() => {
    hostState.fetchRef.mockReset();
    hostState.readDiff.mockReset();
  });

  it("persists a server-derived migration partition only after the live heads remain exact", async () => {
    const pool = new SchedulerFactsPool();
    hostState.fetchRef.mockImplementation(async ({ remoteBranch }: { remoteBranch: string }) =>
      remoteBranch === "main" ? BASE : HEAD,
    );
    hostState.readDiff.mockResolvedValue(
      "diff --git a/db/migrations/0101_x.sql b/db/migrations/0101_x.sql\n+++ b/db/migrations/0101_x.sql",
    );

    const result = await subject(pool).resolve(snapshot(), snapshot().entries);

    expect(result).toMatchObject({ kind: "resolved", baseSha: BASE, members: [{ headSha: HEAD }] });
    expect(pool.updates).toEqual([
      { partitionId: "partition_semantic", fingerprint: semanticFingerprint("migration:database") },
    ]);
  });

  it("rejects a base change inside the fenced persistence transaction without changing queue partition state", async () => {
    const pool = new SchedulerFactsPool();
    let mainReads = 0;
    hostState.fetchRef.mockImplementation(async ({ remoteBranch }: { remoteBranch: string }) => {
      if (remoteBranch !== "main") return HEAD;
      mainReads += 1;
      return mainReads < 3 ? BASE : "c".repeat(40);
    });
    hostState.readDiff.mockResolvedValue(
      "diff --git a/services/worker/src/a.ts b/services/worker/src/a.ts\n+++ b/services/worker/src/a.ts",
    );

    await expect(subject(pool).resolve(snapshot(), snapshot().entries)).resolves.toEqual({
      kind: "stale",
      reason: "snapshot_changed_before_partition_persist",
    });
    expect(pool.updates).toEqual([]);
  });

  it("holds when an active lease is structurally ambiguous before calling CodeHost", async () => {
    const pool = new SchedulerFactsPool();
    pool.malformedLease = true;

    await expect(subject(pool).resolve(snapshot(), snapshot().entries)).resolves.toEqual({
      kind: "stale",
      reason: "ambiguous_partition_lease",
    });
    expect(hostState.fetchRef).not.toHaveBeenCalled();
  });

  it("rejects a run branch change before any canonical partition write", async () => {
    const pool = new SchedulerFactsPool();
    pool.branchChangedAfterRead = true;
    hostState.fetchRef.mockImplementation(async ({ remoteBranch }: { remoteBranch: string }) =>
      remoteBranch === "main" ? BASE : HEAD,
    );
    hostState.readDiff.mockResolvedValue(
      "diff --git a/services/worker/src/a.ts b/services/worker/src/a.ts\n+++ b/services/worker/src/a.ts",
    );

    await expect(subject(pool).resolve(snapshot(), snapshot().entries)).resolves.toEqual({
      kind: "stale",
      reason: "snapshot_changed_before_partition_persist",
    });
    expect(pool.updates).toEqual([]);
  });
});

function semanticFingerprint(scope: string): string {
  return `semantic:v1:${encodeURIComponent(scope)}`;
}
