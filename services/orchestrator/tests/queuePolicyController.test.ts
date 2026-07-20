import { describe, expect, it } from "vitest";
import { QueuePolicyController } from "../src/engine/merge/queuePolicyController.js";

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

const QUEUE_ROW = {
  queue_id: "queue_1",
  project_id: "project_1",
  target_branch: "main",
  policy_snapshot: { policyId: "policy_1" },
  route_snapshot: { route: "main", batchLimit: 1, deployGroupLimit: 1 },
  priority_snapshot: { priority: "P1", aging: { enabled: true, step: 1 } },
  priority_override: null,
  lease_owner: "worker_1",
  lease_epoch: 7,
  partition_state: "active",
};

interface QueryCall {
  sql: string;
  params: readonly unknown[] | undefined;
}

function client(responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const calls: QueryCall[] = [];
  return {
    calls,
    query: async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      const response = responses.shift();
      return { rows: response?.rows ?? [], rowCount: response?.rowCount ?? 0 };
    },
  };
}

function claim() {
  return {
    kind: "claim" as const,
    orgId: "org_1",
    projectId: "project_1",
    queueId: "queue_1",
    leaseOwner: "worker_1",
    leaseEpoch: 7,
  };
}

describe("QueuePolicyController final claim fence", () => {
  it("admits only an active policy route with its required live window", async () => {
    const db = client([
      { rows: [{ id: "policy_1", body: POLICY, active: true }] },
      { rows: [{ name: "business", kind: "allow" }] },
      { rows: [] },
    ]);
    const controller = new QueuePolicyController({} as never);

    await expect(
      controller.applyOnClient(db as never, {
        kind: "admission",
        orgId: "org_1",
        projectId: "project_1",
        targetBranch: "main",
      }),
    ).resolves.toMatchObject({ kind: "admit", policyId: "policy_1", route: "main", batchLimit: 1 });
  });

  it("holds admission on a live blackout and leaves an empty coordination pass non-terminal", async () => {
    const blackoutDb = client([
      { rows: [{ id: "policy_1", body: POLICY, active: true }] },
      { rows: [{ name: "emergency", kind: "blackout" }] },
    ]);
    const controller = new QueuePolicyController({} as never);

    await expect(
      controller.applyOnClient(blackoutDb as never, {
        kind: "admission",
        orgId: "org_1",
        projectId: "project_1",
        targetBranch: "main",
      }),
    ).resolves.toEqual({ kind: "hold", reason: "blackout" });

    const emptyQueueDb = client([{ rows: [] }]);
    await expect(
      controller.applyOnClient(emptyQueueDb as never, {
        kind: "coordinate",
        orgId: "org_1",
        projectId: "project_1",
      }),
    ).resolves.toEqual(new Set());
  });

  it("persists an authorized freeze command once and records its durable result", async () => {
    const db = client([
      { rows: [] },
      { rows: [{ id: "policy_1", body: POLICY, active: true }] },
      { rowCount: 2 },
      { rowCount: 1 },
      { rowCount: 1 },
    ]);
    const controller = new QueuePolicyController({} as never);

    await expect(
      controller.applyOnClient(db as never, {
        kind: "command",
        orgId: "org_1",
        projectId: "project_1",
        actorId: "actor_1",
        command: {
          schemaVersion: "queue_command.v1",
          command: "freeze",
          idempotencyKey: "freeze_new",
          scope: { projectId: "project_1", targetBranch: "main" },
          reason: "safety stop",
        },
      }),
    ).resolves.toEqual({ state: "frozen", affected: 2 });
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO merge_queue_commands"))).toBe(true);
    expect(db.calls.some((call) => call.params?.includes("merge.queue.command_applied"))).toBe(true);
  });

  it("rejects a blank command actor before it can issue a mutation", async () => {
    const db = client([]);
    const controller = new QueuePolicyController({} as never);

    await expect(
      controller.applyOnClient(db as never, {
        kind: "command",
        orgId: "org_1",
        projectId: "project_1",
        actorId: " ",
        command: {
          schemaVersion: "queue_command.v1",
          command: "freeze",
          idempotencyKey: "freeze_bad_actor",
          scope: { projectId: "project_1" },
          reason: "safety stop",
        },
      }),
    ).rejects.toThrow("queue command scope or actor is invalid");
    expect(db.calls).toHaveLength(0);
  });

  it("requires a queue id for targeted commands, then durably dequeues only that scoped entry", async () => {
    const controller = new QueuePolicyController({} as never);
    const noQueueDb = client([{ rows: [] }, { rows: [{ id: "policy_1", body: POLICY, active: true }] }]);
    const baseCommand = {
      schemaVersion: "queue_command.v1",
      command: "dequeue" as const,
      idempotencyKey: "dequeue_once",
    };

    await expect(
      controller.applyOnClient(noQueueDb as never, {
        kind: "command",
        orgId: "org_1",
        projectId: "project_1",
        actorId: "actor_1",
        command: { ...baseCommand, scope: { projectId: "project_1" } },
      }),
    ).rejects.toThrow("requires a queueId scope");

    const dequeueDb = client([
      { rows: [] },
      { rows: [{ id: "policy_1", body: POLICY, active: true }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
    ]);
    await expect(
      controller.applyOnClient(dequeueDb as never, {
        kind: "command",
        orgId: "org_1",
        projectId: "project_1",
        actorId: "actor_1",
        command: {
          ...baseCommand,
          idempotencyKey: "dequeue_scoped",
          scope: { projectId: "project_1", queueId: "queue_1" },
        },
      }),
    ).resolves.toEqual({ state: "dequeued", affected: 1 });
    expect(dequeueDb.calls.some((call) => call.sql.includes("status = 'dequeued'"))).toBe(true);
  });

  it("holds a freeze observed after proof and fences the status transition by owner and epoch", async () => {
    const db = client([
      { rows: [QUEUE_ROW] },
      { rows: [{ id: "policy_1", body: POLICY, active: true }] },
      { rows: [{ name: "business", kind: "allow" }] },
      { rows: [{ command: "freeze" }] },
      { rowCount: 1 },
      { rows: [] },
    ]);
    const controller = new QueuePolicyController({} as never);

    const result = await controller.applyOnClient(db as never, claim());

    expect(result).toBe(false);
    const hold = db.calls.find((call) => call.sql.includes("SET status = 'held_policy'"));
    expect(hold?.sql).toContain("org_id = $1 AND queue_id = $2 AND status = 'merging' AND lease_owner = $3");
    expect(hold?.params).toEqual(["org_1", "queue_1", "worker_1", 7, "partition_not_active"]);
    expect(db.calls.some((call) => call.params?.includes("merge.queue.admission_held"))).toBe(true);
  });

  it("holds a corrupt policy snapshot instead of treating an empty policy as eligible", async () => {
    const db = client([{ rows: [{ ...QUEUE_ROW, policy_snapshot: {} }] }, { rowCount: 1 }, { rows: [] }]);
    const controller = new QueuePolicyController({} as never);

    expect(await controller.applyOnClient(db as never, claim())).toBe(false);
    const hold = db.calls.find((call) => call.sql.includes("SET status = 'held_policy'"));
    expect(hold?.params).toEqual(["org_1", "queue_1", "worker_1", 7, "malformed_policy"]);
  });

  it("returns a stored command result without a second queue mutation or event", async () => {
    const db = client([{ rows: [{ result: { state: "frozen", affected: 1 } }] }]);
    const controller = new QueuePolicyController({} as never);

    const result = await controller.applyOnClient(db as never, {
      kind: "command",
      orgId: "org_1",
      projectId: "project_1",
      actorId: "actor_1",
      command: {
        schemaVersion: "queue_command.v1",
        command: "freeze",
        idempotencyKey: "freeze_once",
        scope: { projectId: "project_1" },
        reason: "safety stop",
      },
    });

    expect(result).toEqual({ state: "frozen", affected: 1 });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toContain("idempotency_key");
  });

  it("rejects a malformed stored idempotency result rather than reporting command success", async () => {
    const db = client([{ rows: [{ result: { state: "frozen", affected: "one" } }] }]);
    const controller = new QueuePolicyController({} as never);

    await expect(
      controller.applyOnClient(db as never, {
        kind: "command",
        orgId: "org_1",
        projectId: "project_1",
        actorId: "actor_1",
        command: {
          schemaVersion: "queue_command.v1",
          command: "freeze",
          idempotencyKey: "freeze_once",
          scope: { projectId: "project_1" },
          reason: "safety stop",
        },
      }),
    ).rejects.toThrow("stored queue command result is malformed");
    expect(db.calls).toHaveLength(1);
  });
});
