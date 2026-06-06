import { describe, expect, it } from "vitest";
import { PgMergeQueueModel } from "../src/engine/merge/coordinatorPg.js";
import { QueueRecoveryPool } from "./helpers/mergeQueueRecoveryPool.js";

const PROJECT = "project_recover";
const ORG = "org_acme";
const RUN = "run_blocked";
const SPEC = "spec_apex";
const PR_URL = "https://github.com/acme/apex/pull/15";
const CODEX_REF = "credential/codex/org/org_acme/default";
const GITHUB_REF = "credential/github/org/org_acme/default";

function seedBlockedDequeued(pool: QueueRecoveryPool, queueId: string, emitDequeued = true): void {
  pool.seedProject(PROJECT, ORG);
  pool.seedQueue({
    queueId,
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
  if (!emitDequeued) return;
  pool.seedEvent({
    projectId: PROJECT,
    orgId: ORG,
    runId: RUN,
    specId: SPEC,
    eventType: "merge.dequeued",
    ts: new Date("2026-05-01T00:00:00.000Z"),
    payload: { integration: "native_queue", reason: "blocked", prUrl: PR_URL, prNumber: 15 },
  });
}

function seedCredentialBlock(
  pool: QueueRecoveryPool,
  input: { kind?: string; credentialRef?: string; message: string },
): void {
  pool.seedEvent({
    projectId: PROJECT,
    orgId: ORG,
    runId: RUN,
    specId: SPEC,
    eventType: "merge.batch.infra_blocked",
    ts: new Date("2026-05-01T00:00:01.000Z"),
    payload: {
      integration: "native_queue",
      terminal: true,
      kind: input.kind ?? "missing_github_credential",
      ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
      message: input.message,
      members: [{ specId: SPEC, prNumber: 15 }],
    },
  });
}

function seedCredentialRepair(pool: QueueRecoveryPool, eventType: string, payload: Record<string, unknown>): void {
  pool.seedEvent({
    projectId: PROJECT,
    orgId: ORG,
    runId: null,
    specId: null,
    eventType,
    ts: new Date("2026-05-01T00:00:02.000Z"),
    payload: { ...payload, redacted: true },
  });
}

async function recover(pool: QueueRecoveryPool): Promise<number> {
  return new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);
}

describe("PgMergeQueueModel.recoverDequeuedCandidates", () => {
  it("revives a recoverable dequeued native-queue row with PR facts and no later terminal candidate event", async () => {
    const pool = new QueueRecoveryPool();
    seedBlockedDequeued(pool, "mq_blocked");

    const recovered = await recover(pool);

    expect(recovered).toBe(1);
    expect(pool.queue[0]).toMatchObject({ status: "queued", dequeueReason: null, settledAt: null });
  });

  it("does not revive when a later same-candidate merge.completed exists", async () => {
    const pool = new QueueRecoveryPool();
    seedBlockedDequeued(pool, "mq_done");
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
    seedBlockedDequeued(pool, "mq_stale_same_spec");
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

  it("does revive when an older same-spec conflict replan predates a later blocked dequeue", async () => {
    const pool = new QueueRecoveryPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedQueue({
      queueId: "mq_apex_later_blocked",
      runId: RUN,
      specId: SPEC,
      projectId: PROJECT,
      orgId: ORG,
      prUrl: PR_URL,
      prNumber: "15",
      status: "dequeued",
      dequeueReason: "blocked",
      settledAt: new Date("2026-06-05T21:47:33.000Z"),
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: "run_old_conflict",
      specId: SPEC,
      eventType: "merge.conflict.replan_routed",
      ts: new Date("2026-06-05T21:40:00.000Z"),
      payload: { specId: SPEC, newContext: "autonomous replan routed for an earlier conflict" },
    });
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.dequeued",
      ts: new Date("2026-06-05T21:47:33.000Z"),
      payload: { integration: "native_queue", reason: "blocked", prUrl: PR_URL, prNumber: 15 },
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
      eventType: "merge.dequeued",
      ts: new Date("2026-05-01T00:00:00.500Z"),
      payload: { integration: "native_queue", reason: "blocked", prUrl: PR_URL, prNumber: 15 },
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

  it("revives a legacy terminal retriable batch infra halt so deployed fixes can re-drive it", async () => {
    const pool = new QueueRecoveryPool();
    seedBlockedDequeued(pool, "mq_batch_terminal", false);
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

    expect(recovered).toBe(1);
    expect(pool.queue[0]?.status).toBe("queued");
    expect(pool.queue[0]?.dequeueReason).toBe(null);
  });

  it("does not revive an ambiguous terminal batch infra halt that could double-merge", async () => {
    const pool = new QueueRecoveryPool();
    seedBlockedDequeued(pool, "mq_batch_ambiguous_terminal", false);
    pool.seedEvent({
      projectId: PROJECT,
      orgId: ORG,
      runId: RUN,
      specId: SPEC,
      eventType: "merge.batch.infra_blocked",
      ts: new Date("2026-05-01T00:00:01.000Z"),
      payload: {
        integration: "native_queue",
        terminal: true,
        kind: "ambiguous_merge_state",
        message: "merge drive state ambiguous; auto-retry could double-merge",
        members: [{ specId: SPEC, prNumber: 15 }],
      },
    });

    const recovered = await new PgMergeQueueModel(pool.asPgPool()).recoverDequeuedCandidates(PROJECT);

    expect(recovered).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");
  });

  it("revives a terminal GitHub credential halt only after a later matching credential repair event", async () => {
    const pool = new QueueRecoveryPool();
    seedBlockedDequeued(pool, "mq_missing_credential_repaired");
    seedCredentialBlock(pool, {
      kind: "missing_required_credential",
      credentialRef: GITHUB_REF,
      message: `missing GitHub credential ref: ${GITHUB_REF}`,
    });

    const beforeRepair = await recover(pool);
    expect(beforeRepair).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");

    seedCredentialRepair(pool, "credential.configured", {
      provider: "github",
      credentialKind: "github_token",
      ref: GITHUB_REF,
    });

    const recovered = await recover(pool);

    expect(recovered).toBe(1);
    expect(pool.queue[0]).toMatchObject({ status: "queued", dequeueReason: null, settledAt: null });
  });

  it("revives a sole terminal missing-GitHub-credential batch halt after matching repair", async () => {
    const pool = new QueueRecoveryPool();
    seedBlockedDequeued(pool, "mq_missing_github_credential_repaired", false);
    seedCredentialBlock(pool, {
      credentialRef: GITHUB_REF,
      message: `missing GitHub credential ref: ${GITHUB_REF}`,
    });

    const beforeRepair = await recover(pool);
    expect(beforeRepair).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");

    seedCredentialRepair(pool, "credential.github.configured", {
      provider: "github",
      credentialKind: "github_token",
      credentialRef: GITHUB_REF,
    });

    const recovered = await recover(pool);

    expect(recovered).toBe(1);
    expect(pool.queue[0]).toMatchObject({ status: "queued", dequeueReason: null, settledAt: null });
  });

  it("does not revive a null-ref GitHub credential halt after an unrelated generic credential import", async () => {
    const pool = new QueueRecoveryPool();
    seedBlockedDequeued(pool, "mq_missing_github_null_ref_unrelated_repair", false);
    seedCredentialBlock(pool, { message: "No GitHub credential configured" });
    seedCredentialRepair(pool, "credential.configured", {
      provider: "codex",
      credentialKind: "codex_chatgpt_auth",
      ref: CODEX_REF,
    });

    const recovered = await recover(pool);

    expect(recovered).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");
  });

  it("revives a null-ref GitHub credential halt after GitHub is configured", async () => {
    const pool = new QueueRecoveryPool();
    seedBlockedDequeued(pool, "mq_missing_github_null_ref_github_repair", false);
    seedCredentialBlock(pool, { message: "No GitHub credential configured" });

    const beforeRepair = await recover(pool);
    expect(beforeRepair).toBe(0);
    expect(pool.queue[0]?.status).toBe("dequeued");

    seedCredentialRepair(pool, "credential.github.configured", {
      provider: "github",
      credentialKind: "github_token",
      credentialRef: GITHUB_REF,
    });

    const recovered = await recover(pool);

    expect(recovered).toBe(1);
    expect(pool.queue[0]).toMatchObject({ status: "queued", dequeueReason: null, settledAt: null });
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
