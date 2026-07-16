// Real-Postgres proof for the atomic recovery park authority. Gated like the
// existing run-state writer conformance cohort: TANREN_RLS_DB_TEST=1 plus an
// owner DATABASE_URL. It pins direct/HTTP parity, exact event order, enforced
// wrong-org failure, rollback after a partial attempt, and lost-response retry.

import type { Pool, PoolClient } from "pg";
import { resetSystemPool, setSystemPool } from "@tanren/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AllowAllPeerVerifier,
  type MtlsFetch,
  type RecoveryOwnedSettleInput,
  type RecoveryParkInput,
} from "../src/engine/contracts/index.js";
import { readOwnedReceiptEvidence } from "../src/engine/merge/recoveryEvidencePg.js";
import { DirectRunStateWriter, HttpRunStateWriter } from "../src/engine/worker/index.js";
import { applyRecoveryParkAtomic } from "../src/engine/worker/recoveryParkAtomic.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";
import {
  createWriteEndpointHarness,
  enabled,
  fetchInto,
  ORG,
  PROJECT,
  seedRun,
  SPEC,
} from "./planeSplitP3RemoteWritesHarness.js";

const describeDb = enabled ? describe : describe.skip;

function inputFor(runId: string, queueId: string, orgId = ORG): RecoveryParkInput {
  return {
    orgId,
    projectId: PROJECT,
    queueId,
    runId,
    specId: SPEC,
    message: `irreconcilable recovery for ${runId}`,
  };
}

function ownedInput(runId: string, queueId: string, ownerRunId: string): RecoveryOwnedSettleInput {
  return {
    orgId: ORG,
    projectId: PROJECT,
    queueId,
    runId,
    specId: SPEC,
    receipt: { kind: "planner_replan", specId: SPEC, run: { kind: "already_running", runId: ownerRunId } },
    reason: "conflict",
    message: `successor ${ownerRunId} owns recovery`,
  };
}

async function seedQueue(owner: Pool, runId: string, queueId: string): Promise<void> {
  await seedRun(owner, runId);
  await owner.query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]);
  await owner.query(
    `INSERT INTO merge_queue
       (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number, claimed_at)
     VALUES ($1, $2, $3, $4, $5, 'merging', $6, $7, now())`,
    [queueId, runId, SPEC, PROJECT, ORG, `https://github.example/pulls/${queueId}`, "17"],
  );
}

async function expectLocked(client: PoolClient, sql: string, params: unknown[]): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '100ms'");
    await expect(client.query(sql, params)).rejects.toMatchObject({ code: "55P03" });
  } finally {
    await client.query("ROLLBACK");
  }
}

async function durableState(owner: Pool, runId: string, queueId: string) {
  const spec = await owner.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
  const queue = await owner.query<{ status: string; dequeue_reason: string | null }>(
    "SELECT status, dequeue_reason FROM merge_queue WHERE queue_id = $1",
    [queueId],
  );
  const events = await owner.query<{ event_type: string }>(
    "SELECT event_type FROM events WHERE run_id = $1 ORDER BY id ASC",
    [runId],
  );
  return {
    specStatus: spec.rows[0]?.status,
    queue: queue.rows[0],
    events: events.rows.map((row) => row.event_type),
  };
}

describeDb("atomic recovery park — real PG and enforced RLS", () => {
  const harness = createWriteEndpointHarness();
  const owner = () => harness.ownerPool();
  const runtime = () => harness.runtimePool();

  beforeAll(async () => {
    await harness.setUp();
    setSystemPool(owner());
  }, 60_000);
  afterAll(async () => {
    resetSystemPool();
    await harness.tearDown();
  }, 30_000);

  it("Direct and HTTP paths commit the same park, ordered events, and dequeue", async () => {
    const directRun = "run_recovery_park_direct";
    const directQueue = "queue_recovery_park_direct";
    await seedQueue(owner(), directRun, directQueue);
    const direct = await new DirectRunStateWriter(runtime()).parkRecoveryAndDequeue(inputFor(directRun, directQueue));
    expect(direct).toEqual({ kind: "parked", newlyParked: true });
    expect(await durableState(owner(), directRun, directQueue)).toEqual({
      specStatus: "needs_attention",
      queue: { status: "dequeued", dequeue_reason: "needs_attention" },
      events: ["dag.spec.needs_attention", "merge.dequeued"],
    });

    const httpRun = "run_recovery_park_http";
    const httpQueue = "queue_recovery_park_http";
    await seedQueue(owner(), httpRun, httpQueue);
    const app = createInternalRunStateWriteRoutes({ pool: runtime(), verifier: new AllowAllPeerVerifier() });
    const http = await new HttpRunStateWriter("https://control.internal", fetchInto(app)).parkRecoveryAndDequeue(
      inputFor(httpRun, httpQueue),
    );
    expect(http).toEqual(direct);
    expect(await durableState(owner(), httpRun, httpQueue)).toEqual({
      specStatus: "needs_attention",
      queue: { status: "dequeued", dequeue_reason: "needs_attention" },
      events: ["dag.spec.needs_attention", "merge.dequeued"],
    });
  });

  it("wrong-org and missing ownership fail closed without claiming unproved retention", async () => {
    const runId = "run_recovery_park_wrong_org";
    const queueId = "queue_recovery_park_wrong_org";
    const otherRunId = "run_recovery_park_tuple_mismatch";
    await seedQueue(owner(), runId, queueId);
    await seedRun(owner(), otherRunId);
    const direct = new DirectRunStateWriter(runtime());

    await expect(direct.parkRecoveryAndDequeue(inputFor(runId, queueId, "org_other"))).resolves.toMatchObject({
      kind: "parking_failed",
      reason: "ownership_missing",
      queueDisposition: "unknown",
    });
    await expect(direct.parkRecoveryAndDequeue(inputFor(runId, "queue_missing"))).resolves.toMatchObject({
      kind: "parking_failed",
      reason: "ownership_missing",
      queueDisposition: "unknown",
    });
    await expect(direct.parkRecoveryAndDequeue(inputFor(otherRunId, queueId))).resolves.toMatchObject({
      kind: "parking_failed",
      reason: "ownership_missing",
      queueDisposition: "unknown",
    });
    const app = createInternalRunStateWriteRoutes({ pool: runtime(), verifier: new AllowAllPeerVerifier() });
    await expect(
      new HttpRunStateWriter("https://control.internal", fetchInto(app)).parkRecoveryAndDequeue(
        inputFor(runId, queueId, "org_other"),
      ),
    ).resolves.toMatchObject({ kind: "parking_failed", reason: "ownership_missing", queueDisposition: "unknown" });
    expect(await durableState(owner(), runId, queueId)).toEqual({
      specStatus: "in_flight",
      queue: { status: "merging", dequeue_reason: null },
      events: [],
    });
  });

  it("rejects a physically cross-linked queue tuple without mutation", async () => {
    const runId = "run_recovery_park_cross_link";
    const queueId = "queue_recovery_park_cross_link";
    const otherSpec = "spec_recovery_park_cross_link";
    await seedRun(owner(), runId);
    await owner().query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'cross', 'cross', 'in_flight')`,
      [otherSpec, PROJECT, ORG],
    );
    await expect(
      owner().query(
        `INSERT INTO merge_queue
           (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number, claimed_at)
         VALUES ($1, $2, $3, $4, $5, 'merging', $6, '17', now())`,
        [queueId, runId, otherSpec, PROJECT, ORG, `https://github.example/pulls/${queueId}`],
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "merge_queue_run_lineage_fk" });
    const spec = await owner().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [otherSpec]);
    const queue = await owner().query("SELECT queue_id FROM merge_queue WHERE queue_id = $1", [queueId]);
    const events = await owner().query("SELECT id FROM events WHERE run_id = $1", [runId]);
    expect({ spec: spec.rows[0]?.status, queues: queue.rowCount, events: events.rowCount }).toEqual({
      spec: "in_flight",
      queues: 0,
      events: 0,
    });
  });

  it("locks the exact queue/run/spec/project ownership tuple against concurrent mutation", async () => {
    const runId = "run_recovery_park_lock_tuple";
    const queueId = "queue_recovery_park_lock_tuple";
    await seedQueue(owner(), runId, queueId);
    const locker = await owner().connect();
    try {
      await locker.query("BEGIN");
      await expect(applyRecoveryParkAtomic(locker, inputFor(runId, queueId))).resolves.toEqual({
        kind: "parked",
        newlyParked: true,
      });
      for (const [sql, params] of [
        ["UPDATE merge_queue SET claimed_at = claimed_at WHERE queue_id = $1", [queueId]],
        ["UPDATE runs SET outcome = outcome WHERE run_id = $1", [runId]],
        ["UPDATE specs SET description = description WHERE spec_id = $1", [SPEC]],
        ["UPDATE projects SET name = name WHERE project_id = $1", [PROJECT]],
      ] as const) {
        const contender = await owner().connect();
        try {
          await expectLocked(contender, sql, [...params]);
        } finally {
          contender.release();
        }
      }
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    expect(await durableState(owner(), runId, queueId)).toEqual({
      specStatus: "in_flight",
      queue: { status: "merging", dequeue_reason: null },
      events: [],
    });
  });

  it("an event-store permission failure rolls back the prior spec UPDATE and retains the queue", async () => {
    const runId = "run_recovery_park_rollback";
    const queueId = "queue_recovery_park_rollback";
    await seedQueue(owner(), runId, queueId);
    await owner().query("REVOKE INSERT ON TABLE events FROM tanren_app");
    try {
      await expect(
        new DirectRunStateWriter(runtime()).parkRecoveryAndDequeue(inputFor(runId, queueId)),
      ).resolves.toMatchObject({ kind: "parking_failed", reason: "write_failed", retryAfterMs: 3_000 });
    } finally {
      await owner().query("GRANT INSERT ON TABLE events TO tanren_app");
    }
    expect(await durableState(owner(), runId, queueId)).toEqual({
      specStatus: "in_flight",
      queue: { status: "merging", dequeue_reason: null },
      events: [],
    });
  });

  it("a dropped response returns transport uncertainty, then idempotent redrive proves the commit", async () => {
    const runId = "run_recovery_park_response_loss";
    const queueId = "queue_recovery_park_response_loss";
    await seedQueue(owner(), runId, queueId);
    const app = createInternalRunStateWriteRoutes({ pool: runtime(), verifier: new AllowAllPeerVerifier() });
    const intoApp = fetchInto(app);
    let dropResponse = true;
    const lossy: MtlsFetch = async (url, init) => {
      const response = await intoApp(url, init);
      if (dropResponse) {
        dropResponse = false;
        throw new Error("response lost after server commit");
      }
      return response;
    };
    const writer = new HttpRunStateWriter("https://control.internal", lossy);

    await expect(writer.parkRecoveryAndDequeue(inputFor(runId, queueId))).resolves.toMatchObject({
      kind: "parking_failed",
      reason: "transport_failed",
      retryAfterMs: 3_000,
    });
    // A human may legally resolve/re-open the spec before the client replays its
    // lost acknowledgement. The exact settled queue row remains the receipt.
    await owner().query("UPDATE specs SET status = 'open' WHERE spec_id = $1", [SPEC]);
    await expect(writer.parkRecoveryAndDequeue(inputFor(runId, queueId))).resolves.toEqual({
      kind: "parked",
      newlyParked: false,
    });
    expect(await durableState(owner(), runId, queueId)).toEqual({
      specStatus: "open",
      queue: { status: "dequeued", dequeue_reason: "needs_attention" },
      events: ["dag.spec.needs_attention", "merge.dequeued"],
    });
  });

  it("atomically verifies an exact active successor, appends once, and retires once across replay", async () => {
    const runId = "run_recovery_owned_old";
    const queueId = "queue_recovery_owned_old";
    const ownerRunId = "run_recovery_owned_new";
    await seedQueue(owner(), runId, queueId);
    await seedRun(owner(), ownerRunId, "running");
    const writer = new DirectRunStateWriter(runtime());
    const input = ownedInput(runId, queueId, ownerRunId);

    await expect(writer.settleOwnedRecoveryAndDequeue(input)).resolves.toEqual({
      kind: "settled",
      newlySettled: true,
    });
    const committed = await owner().query<{ xmin: string; status: string; dequeue_reason: string | null }>(
      "SELECT xmin::text, status, dequeue_reason FROM merge_queue WHERE queue_id = $1",
      [queueId],
    );
    // Replay is receipt-bound, not successor-liveness-bound: the exact committed
    // fingerprint remains valid after the successor later terminates.
    await owner().query("UPDATE runs SET status = 'halted' WHERE run_id = $1", [ownerRunId]);
    await expect(writer.settleOwnedRecoveryAndDequeue(input)).resolves.toEqual({
      kind: "settled",
      newlySettled: false,
    });
    await expect(
      writer.settleOwnedRecoveryAndDequeue({
        ...input,
        receipt: {
          kind: "planner_replan",
          specId: SPEC,
          run: { kind: "already_running", runId: "run_wrong_same_reason" },
        },
      }),
    ).resolves.toMatchObject({
      kind: "settlement_failed",
      reason: "receipt_mismatch",
      queueDisposition: "unknown",
    });
    const replayed = await owner().query<{ xmin: string }>("SELECT xmin::text FROM merge_queue WHERE queue_id = $1", [
      queueId,
    ]);
    const events = await owner().query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE run_id = $1 ORDER BY id",
      [runId],
    );
    expect(committed.rows[0]).toMatchObject({ status: "dequeued", dequeue_reason: "conflict" });
    expect(replayed.rows[0]?.xmin).toBe(committed.rows[0]?.xmin);
    expect(events.rows.map((row) => row.event_type)).toEqual(["merge.dequeued"]);
  });

  it("rechecks freshness in the retirement transaction after an earlier active lookup", async () => {
    const runId = "run_recovery_owned_stale_old";
    const queueId = "queue_recovery_owned_stale_old";
    const ownerRunId = "run_recovery_owned_stale_new";
    await seedQueue(owner(), runId, queueId);
    await seedRun(owner(), ownerRunId, "running");
    const input = ownedInput(runId, queueId, ownerRunId);
    await expect(
      readOwnedReceiptEvidence(owner(), {
        expectedOrgId: ORG,
        expectedProjectId: PROJECT,
        expectedSpecId: SPEC,
        receipt: input.receipt,
      }),
    ).resolves.toMatchObject({ runId: ownerRunId, runStatus: "running" });

    await owner().query("UPDATE runs SET status = 'halted' WHERE run_id = $1", [ownerRunId]);
    await expect(new DirectRunStateWriter(runtime()).settleOwnedRecoveryAndDequeue(input)).resolves.toMatchObject({
      kind: "settlement_failed",
      reason: "evidence_invalid",
      queueDisposition: "retained",
    });
    expect(await durableState(owner(), runId, queueId)).toEqual({
      specStatus: "in_flight",
      queue: { status: "merging", dequeue_reason: null },
      events: [],
    });
  });

  it("rejects wrong old tuple, successor run/spec/task/kind/status before any event or retirement", async () => {
    const runId = "run_recovery_owned_negative_old";
    const queueId = "queue_recovery_owned_negative_old";
    const ownerRunId = "run_recovery_owned_negative_new";
    const haltedRunId = "run_recovery_owned_negative_halted";
    const taskId = "task_recovery_owned_wrong_kind";
    await seedQueue(owner(), runId, queueId);
    await seedRun(owner(), ownerRunId, "running");
    await seedRun(owner(), haltedRunId, "halted");
    await owner().query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'write', 'write', 'running', 'writer', 'fake', 'm')`,
      [taskId, ownerRunId, ORG],
    );
    const base = ownedInput(runId, queueId, ownerRunId);
    const attempts: RecoveryOwnedSettleInput[] = [
      { ...base, orgId: "org_wrong" },
      { ...base, projectId: "project_wrong" },
      { ...base, runId: "run_wrong" },
      { ...base, specId: "spec_wrong" },
      { ...base, receipt: { ...base.receipt, specId: "spec_wrong" } },
      {
        ...base,
        receipt: { kind: "planner_replan", specId: SPEC, run: { kind: "already_running", runId: "run_missing" } },
      },
      {
        ...base,
        receipt: { kind: "planner_replan", specId: SPEC, run: { kind: "already_running", runId } },
      },
      {
        ...base,
        receipt: {
          kind: "planner_replan",
          specId: SPEC,
          run: { kind: "enqueued", replanRunId: ownerRunId, plannerTaskId: "task_missing" },
        },
      },
      {
        ...base,
        receipt: {
          kind: "planner_replan",
          specId: SPEC,
          run: { kind: "enqueued", replanRunId: ownerRunId, plannerTaskId: taskId },
        },
      },
      {
        ...base,
        receipt: { kind: "planner_replan", specId: SPEC, run: { kind: "already_running", runId: haltedRunId } },
      },
    ];
    for (const attempt of attempts) {
      await expect(new DirectRunStateWriter(runtime()).settleOwnedRecoveryAndDequeue(attempt)).resolves.toMatchObject({
        kind: "settlement_failed",
      });
    }
    expect(await durableState(owner(), runId, queueId)).toEqual({
      specStatus: "in_flight",
      queue: { status: "merging", dequeue_reason: null },
      events: [],
    });
  });

  it("lost owned-settle acknowledgement redrives to the committed queue receipt", async () => {
    const runId = "run_recovery_owned_response_loss_old";
    const queueId = "queue_recovery_owned_response_loss_old";
    const ownerRunId = "run_recovery_owned_response_loss_new";
    await seedQueue(owner(), runId, queueId);
    await seedRun(owner(), ownerRunId, "running");
    const app = createInternalRunStateWriteRoutes({ pool: runtime(), verifier: new AllowAllPeerVerifier() });
    const intoApp = fetchInto(app);
    let drop = true;
    const lossy: MtlsFetch = async (url, init) => {
      const response = await intoApp(url, init);
      if (drop) {
        drop = false;
        throw new Error("response lost after commit");
      }
      return response;
    };
    const writer = new HttpRunStateWriter("https://control.internal", lossy);
    const input = ownedInput(runId, queueId, ownerRunId);
    await expect(writer.settleOwnedRecoveryAndDequeue(input)).resolves.toMatchObject({
      kind: "settlement_failed",
      reason: "transport_failed",
    });
    await expect(writer.settleOwnedRecoveryAndDequeue(input)).resolves.toEqual({
      kind: "settled",
      newlySettled: false,
    });
    expect((await durableState(owner(), runId, queueId)).events).toEqual(["merge.dequeued"]);
  });
});
