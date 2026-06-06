import { describe, expect, it } from "vitest";
import { PgMergeQueueModel } from "../src/engine/merge/coordinatorPg.js";
import { QueueRecoveryPool } from "./helpers/mergeQueueRecoveryPool.js";

const PROJECT = "project_recover";
const ORG = "org_acme";
const RUN = "run_blocked";
const SPEC = "spec_apex";
const PR_URL = "https://github.com/acme/apex/pull/15";

describe("PgMergeQueueModel.recoverDequeuedCandidates", () => {
  it("revives a recoverable dequeued native-queue row with PR facts and no later terminal candidate event", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_blocked",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "blocked",
      settledAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.dequeued",
      ts: new Date("2026-05-01T00:00:00.000Z"),
      payload: { integration: "native_queue", reason: "blocked", prUrl: PR_URL, prNumber: 15 },
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(1);
    expect(pool.queue[0]).toMatchObject({ status: "queued", dequeueReason: null, settledAt: null });
  });

  it("does not revive when a later same-candidate merge.completed exists", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_done",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "blocked",
      settledAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.dequeued",
      ts: new Date("2026-05-01T00:00:00.000Z"),
      payload: { integration: "native_queue", reason: "blocked", prUrl: PR_URL, prNumber: 15 },
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.completed",
      ts: new Date("2026-05-01T00:00:01.000Z"),
      payload: { integration: "native_queue", prUrl: PR_URL, prNumber: 15 },
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");
  });

  it("does not revive a terminal conflict with only a native-queue dequeue signal", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_conflict",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "conflict",
      settledAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.dequeued",
      ts: new Date("2026-05-01T00:00:00.000Z"),
      payload: { integration: "native_queue", reason: "conflict", prUrl: PR_URL, prNumber: 15 },
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");
  });

  it("does revive when a later same-spec merge.completed belongs to a different PR", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_stale_same_spec",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "blocked",
      settledAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.dequeued",
      ts: new Date("2026-05-01T00:00:00.000Z"),
      payload: { integration: "native_queue", reason: "blocked", prUrl: PR_URL, prNumber: 15 },
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: "run_other",
      specId: SPEC,
      eventType: "merge.completed",
      ts: new Date("2026-05-01T00:00:01.000Z"),
      payload: { integration: "native_queue", prUrl: "https://github.com/acme/apex/pull/14", prNumber: 14 },
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(1);
    expect(pool.queue[0]?.status).toBe("queued");
  });

  it("does not revive after a terminal same-candidate infra halt", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_terminal",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "blocked",
      settledAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.queue.infra_blocked",
      ts: new Date("2026-05-01T00:00:01.000Z"),
      payload: { integration: "native_queue", prUrl: PR_URL, prNumber: 15, kind: "ceiling" },
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");
  });

  it("does not revive a current batch-bisect culprit dequeue", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_culprit",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "conflict",
      settledAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.dequeued",
      ts: new Date("2026-05-01T00:00:00.000Z"),
      payload: { integration: "native_queue", reason: "conflict", prUrl: PR_URL, prNumber: 15 },
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.batch.culprit",
      ts: new Date("2026-05-01T00:00:01.000Z"),
      payload: { integration: "native_queue", runId: RUN, specId: SPEC, prNumber: 15 },
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");
  });

  it("does not revive after a terminal batch infra halt", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_batch_terminal",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "blocked",
      settledAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.dequeued",
      ts: new Date("2026-05-01T00:00:00.000Z"),
      payload: { integration: "native_queue", reason: "blocked", prUrl: PR_URL, prNumber: 15 },
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.batch.infra_blocked",
      ts: new Date("2026-05-01T00:00:01.000Z"),
      payload: { integration: "native_queue", terminal: true, members: [{ specId: SPEC, prNumber: 15 }] },
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");
  });

  it("does not revive when a same-run active row appears before the recovery write", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_legacy",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "blocked",
      settledAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.dequeued",
      ts: new Date("2026-05-01T00:00:00.000Z"),
      payload: { integration: "native_queue", reason: "blocked", prUrl: PR_URL, prNumber: 15 },
    });
    pool.beforeRecoveryWrite(() => {
      pool.seedQueue({
        queueId: "mq_active_same_run",
        runId: RUN,
        specId: SPEC,
        projectId: PROJECT,
        orgId: ORG,
        prUrl: PR_URL,
        prNumber: "15",
        status: "queued",
        dequeueReason: null,
        settledAt: null,
      });
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");
  });

  it("does not revive when conflict routing records replan before the dequeue event", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_replanned",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "conflict",
      settledAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.conflict.replan_routed",
      ts: new Date("2026-05-01T00:00:00.000Z"),
      payload: { specId: SPEC, newContext: "replan over the conflicting change", replanStatus: "in_flight" },
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.dequeued",
      ts: new Date("2026-05-01T00:00:01.000Z"),
      payload: { integration: "native_queue", reason: "conflict", prUrl: PR_URL, prNumber: 15 },
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");
  });
});
