import { describe, expect, it, vi } from "vitest";
import { insertPolicyQueueEntry } from "../src/engine/merge/queuePolicyAdmission.js";

describe("insertPolicyQueueEntry", () => {
  it("persists the exact admitted policy, route, and priority snapshots before queueing", async () => {
    const query = vi.fn<(sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>(
      async () => ({ rows: [], rowCount: 1 }),
    );
    const applyOnClient = vi.fn<
      (
        client: unknown,
        input: unknown,
      ) => Promise<{
        kind: "admit";
        policyId: string;
        route: string;
        priority: "P1";
        aging: { enabled: boolean; step: number };
        mode: "serial";
        capacity: number;
        batchLimit: number;
        deployGroupLimit: number;
      }>
    >(async () => ({
      kind: "admit" as const,
      policyId: "policy_1",
      route: "main",
      priority: "P1" as const,
      aging: { enabled: true, step: 1 },
      mode: "serial" as const,
      capacity: 1,
      batchLimit: 1,
      deployGroupLimit: 1,
    }));
    const ensureOnClient = vi.fn<(client: unknown, input: unknown) => Promise<{ id: string }>>(async () => ({
      id: "partition_1",
    }));

    await insertPolicyQueueEntry({
      client: { query } as never,
      orgId: "org_1",
      policy: { applyOnClient } as never,
      partitions: { ensureOnClient } as never,
      queueId: "queue_1",
      entry: { projectId: "project_1", runId: "run_1", specId: "spec_1", prUrl: "https://pr/1", prNumber: 1 },
    });

    expect(applyOnClient).toHaveBeenCalledWith(expect.anything(), {
      kind: "admission",
      orgId: "org_1",
      projectId: "project_1",
      targetBranch: "main",
    });
    expect(ensureOnClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "serial", capacity: 1 }),
    );
    const inserted = query.mock.calls[0]?.[1] as unknown[];
    expect(inserted).toContain(JSON.stringify({ policyId: "policy_1" }));
    expect(inserted).toContain(JSON.stringify({ route: "main", batchLimit: 1, deployGroupLimit: 1 }));
    expect(inserted).toContain(JSON.stringify({ priority: "P1", aging: { enabled: true, step: 1 } }));
  });
});
