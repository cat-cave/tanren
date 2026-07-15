// Real-Postgres proof for the atomic recovery park authority. Gated like the
// existing run-state writer conformance cohort: TANREN_RLS_DB_TEST=1 plus an
// owner DATABASE_URL. It pins direct/HTTP parity, exact event order, enforced
// wrong-org failure, rollback after a partial attempt, and lost-response retry.

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AllowAllPeerVerifier, type MtlsFetch, type RecoveryParkInput } from "../src/engine/contracts/index.js";
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

  beforeAll(() => harness.setUp(), 60_000);
  afterAll(() => harness.tearDown(), 30_000);

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
    // Independent FKs permit this corrupt shape: the queue points at otherSpec,
    // while its run still points at SPEC. The ownership join must reject it.
    await owner().query(
      `INSERT INTO merge_queue
         (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number, claimed_at)
       VALUES ($1, $2, $3, $4, $5, 'merging', $6, '17', now())`,
      [queueId, runId, otherSpec, PROJECT, ORG, `https://github.example/pulls/${queueId}`],
    );

    await expect(
      new DirectRunStateWriter(runtime()).parkRecoveryAndDequeue({
        ...inputFor(runId, queueId),
        specId: otherSpec,
      }),
    ).resolves.toMatchObject({ kind: "parking_failed", reason: "ownership_missing", queueDisposition: "unknown" });
    const spec = await owner().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [otherSpec]);
    const queue = await owner().query<{ status: string }>("SELECT status FROM merge_queue WHERE queue_id = $1", [
      queueId,
    ]);
    const events = await owner().query("SELECT id FROM events WHERE run_id = $1", [runId]);
    expect({ spec: spec.rows[0]?.status, queue: queue.rows[0]?.status, events: events.rowCount }).toEqual({
      spec: "in_flight",
      queue: "merging",
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
});
