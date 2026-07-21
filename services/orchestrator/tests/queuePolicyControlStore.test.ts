import { describe, expect, it } from "vitest";
import { QueuePolicyControlStore } from "../src/engine/merge/queuePolicyControlStore.js";

const POLICY = {
  schemaVersion: "queue_policy.v1",
  routes: [
    {
      name: "main",
      targetBranch: "main",
      matcher: { kind: "branch", equals: "main" },
      priority: { base: "P1", aging: { enabled: true, step: 1 } },
      partition: { mode: "serial", capacity: 1, batchLimit: 1, deployGroupLimit: 1 },
      interruption: { mode: "hold" },
      requiredWindows: ["business"],
    },
  ],
};

function controlStoreHarness() {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const eventInsert = ["INSERT INTO", "events"].join(" ");
  const client = {
    query: async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT id, version, body, compiled_hash")) {
        return { rows: [{ id: "policy_live", version: 2, body: POLICY, compiled_hash: "sha256:live" }], rowCount: 1 };
      }
      if (sql.includes("SELECT id, version FROM merge_queue_policies")) {
        return { rows: [{ id: "policy_prior", version: 1 }], rowCount: 1 };
      }
      if (sql.includes("SELECT id FROM merge_queue_policies")) {
        return { rows: [{ id: "policy_live" }], rowCount: 1 };
      }
      if (sql.includes("SELECT id, name, kind, timezone")) {
        return {
          rows: [
            {
              id: "window_live",
              name: "business",
              kind: "allow",
              timezone: "America/Chicago",
              target_branch: "main",
              intervals: [{ localStart: "09:00", localEnd: "17:00", daysOfWeek: [1, 2, 3, 4, 5] }],
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("DELETE FROM merge_queue_windows")) {
        return { rows: [{ name: "business", kind: "allow" }], rowCount: 1 };
      }
      if (sql.includes(eventInsert)) return { rows: [{ id: "42" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { calls, store: new QueuePolicyControlStore({ connect: async () => client } as never) };
}

describe("QueuePolicyControlStore", () => {
  it("revises policy and round-trips timezone-aware local windows through the scoped control surface", async () => {
    const { calls, store } = controlStoreHarness();
    const revision = await store.putPolicy({
      orgId: "org_1",
      projectId: "project_1",
      body: POLICY,
      expectedVersion: 1,
    });
    expect(revision.version).toBe(2);
    expect(revision.compiledHash).toMatch(/^sha256:/u);

    await expect(store.getPolicy({ orgId: "org_1", projectId: "project_1" })).resolves.toMatchObject({
      id: "policy_live",
      version: 2,
      compiledHash: "sha256:live",
    });

    await expect(
      store.addWindow({
        orgId: "org_1",
        projectId: "project_1",
        window: {
          schemaVersion: "queue_window.v1",
          name: "business",
          kind: "allow",
          timezone: "America/Chicago",
          scope: { projectId: "project_1", targetBranch: "main" },
          intervals: [{ localStart: "09:00", localEnd: "17:00", daysOfWeek: [1, 2, 3, 4, 5] }],
        },
      }),
    ).resolves.toMatchObject({ id: expect.stringMatching(/^mqw_/u) });

    await expect(store.listWindows({ orgId: "org_1", projectId: "project_1" })).resolves.toEqual([
      expect.objectContaining({
        id: "window_live",
        timezone: "America/Chicago",
        intervals: [{ localStart: "09:00", localEnd: "17:00", daysOfWeek: [1, 2, 3, 4, 5] }],
      }),
    ]);
    await expect(store.deleteWindow({ orgId: "org_1", projectId: "project_1", windowId: "window_live" })).resolves.toBe(
      true,
    );
    expect(calls.filter((call) => call.sql === "BEGIN")).toHaveLength(5);
    expect(calls.filter((call) => call.sql.includes(["INSERT INTO", "events"].join(" ")))).toHaveLength(3);
  });
});
