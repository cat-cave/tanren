// Real-Postgres proof for terminal infrastructure recovery. It composes the
// production batch coordinator, queue/event adapters, atomic escalator, and the
// credential-repair subscriber handler under enforced tenant RLS.

import { resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MtlsFetch } from "../src/engine/contracts/mtlsChannel.js";
import { AllowAllPeerVerifier } from "../src/engine/contracts/mtlsChannel.js";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { DirectRunStateWriter, HttpRunStateWriter } from "../src/engine/worker/index.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";
import {
  type CoordinatorDeps,
  productionCoordinator,
  redriveCredentialRepair,
  settleCompletedPark,
  throwAmbiguousMerge,
} from "./fixtures/terminalInfrastructureRecovery.js";
import { fakeBatchAuthorityBinding } from "./helpers/mq2BatchAuthority.js";
import { createWriteEndpointHarness, enabled, fetchInto } from "./planeSplitP3RemoteWritesHarness.js";

const describeDb = enabled ? describe : describe.skip;

interface Candidate {
  orgId: string;
  projectId: string;
  specId: string;
  runId: string;
  queueId: string;
}

function candidate(name: string): Candidate {
  return {
    orgId: `org_infra_${name}`,
    projectId: `project_infra_${name}`,
    specId: `spec_infra_${name}`,
    runId: `run_infra_${name}`,
    queueId: `queue_infra_${name}`,
  };
}

async function seedCandidate(owner: Pool, value: Candidate): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [value.orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/infra.git', $2)`,
    [value.projectId, value.orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, $1, $1, 'in_flight')`,
    [value.specId, value.projectId, value.orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [value.runId, value.specId, value.projectId, value.orgId],
  );
  await owner.query(
    `INSERT INTO merge_queue (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6, '23')`,
    [
      value.queueId,
      value.runId,
      value.specId,
      value.projectId,
      value.orgId,
      `https://github.example/pulls/${value.queueId}`,
    ],
  );
}

async function queueState(owner: Pool, value: Candidate) {
  const result = await owner.query<{
    queue_status: string;
    dequeue_reason: string | null;
    spec_status: string;
  }>(
    `SELECT mq.status AS queue_status, mq.dequeue_reason, s.status AS spec_status
       FROM merge_queue mq JOIN specs s ON s.spec_id = mq.spec_id
      WHERE mq.queue_id = $1`,
    [value.queueId],
  );
  return result.rows[0];
}

async function eventTypes(owner: Pool, value: Candidate): Promise<string[]> {
  const result = await owner.query<{ event_type: string }>(
    "SELECT event_type FROM events WHERE run_id = $1 ORDER BY id",
    [value.runId],
  );
  return result.rows.map((row) => row.event_type);
}

describeDb("terminal infrastructure ownership — real PG and enforced RLS", () => {
  const harness = createWriteEndpointHarness();
  const ownerPool = () => harness.ownerPool();
  const runtimePool = () => harness.runtimePool();

  beforeAll(async () => {
    await harness.setUp();
    setSystemPool(ownerPool());
  }, 60_000);
  afterEach(async () => {
    await ownerPool().query("DELETE FROM merge_queue");
  });
  afterAll(async () => {
    resetSystemPool();
    await harness.tearDown();
  }, 30_000);

  it("missing credential remains active, then the repair event re-drives only its tenant to merge", async () => {
    const target = candidate("credential_target");
    const otherTenant = candidate("credential_other_tenant");
    await seedCandidate(ownerPool(), target);
    await seedCandidate(ownerPool(), otherTenant);
    let credentialReady = false;
    const checker: CoordinatorDeps["checker"] = {
      async checkBatch({ entries }) {
        if (!credentialReady) {
          return {
            result: "infra-error",
            message: "No GitHub credential configured for this run",
            retriable: false,
            kind: "missing_required_credential",
          };
        }
        return {
          result: "pass",
          integrationBranch: "tanren/batch/repaired",
          authorityBinding: fakeBatchAuthorityBinding(entries),
        };
      },
    };
    const runner: CoordinatorDeps["runner"] = {
      async driveMerge() {
        return { kind: "merged", mergeSha: "sha_repaired" };
      },
    };
    const writer = new DirectRunStateWriter(orgScopingPool(runtimePool()));
    const coordinator = productionCoordinator(runtimePool(), writer, checker, runner);

    const held = await coordinator.coordinate(target.projectId);
    expect(held).toMatchObject({ holdReason: "infra_error", queueDepth: 1 });
    expect(held.retryAfterMs).toBeGreaterThan(0);
    expect(await queueState(ownerPool(), target)).toEqual({
      queue_status: "queued",
      dequeue_reason: null,
      spec_status: "in_flight",
    });
    expect(await eventTypes(ownerPool(), target)).toContain("merge.batch.infra_blocked");
    expect(await eventTypes(ownerPool(), target)).not.toContain("merge.dequeued");

    credentialReady = true;
    await runWithOrgScope(runtimePool(), target.orgId, () =>
      writer.append({
        runId: target.runId,
        specId: target.specId,
        projectId: target.projectId,
        orgId: target.orgId,
        eventType: "credential.configured",
        payload: {
          provider: "github",
          credentialKind: "github_token",
          ref: `credential/github/${target.orgId}/default`,
          redacted: true,
        },
      }),
    );
    const repair = await ownerPool().query<{ id: string }>(
      `SELECT id::text AS id FROM events
        WHERE run_id = $1 AND event_type = 'credential.configured'
        ORDER BY id DESC LIMIT 1`,
      [target.runId],
    );
    await redriveCredentialRepair({
      pool: runtimePool(),
      coordinator,
      writer,
      eventId: repair.rows[0]!.id,
    });

    expect(await queueState(ownerPool(), target)).toEqual({
      queue_status: "merged",
      dequeue_reason: null,
      spec_status: "in_flight",
    });
    expect(await queueState(ownerPool(), otherTenant)).toEqual({
      queue_status: "queued",
      dequeue_reason: null,
      spec_status: "in_flight",
    });
    const events = await eventTypes(ownerPool(), target);
    expect(events.filter((event) => event === "merge.batch.infra_blocked")).toHaveLength(1);
    expect(events.filter((event) => event === "merge.dequeued")).toHaveLength(0);
    expect(events.filter((event) => event === "merge.queue.advanced")).toHaveLength(1);
  });

  it("an ambiguous merge atomically parks needs_attention once even when its HTTP acknowledgement is lost", async () => {
    const target = candidate("ambiguous_response_loss");
    const otherTenant = candidate("ambiguous_other_tenant");
    await seedCandidate(ownerPool(), target);
    await seedCandidate(ownerPool(), otherTenant);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const intoApp = fetchInto(app);
    let dropPark = true;
    const lossy: MtlsFetch = async (url, init) => {
      const response = await intoApp(url, init);
      if (dropPark && new URL(url).pathname === "/internal/park-recovery-and-dequeue") {
        dropPark = false;
        throw new Error("park acknowledgement lost after commit");
      }
      return response;
    };
    const writer = new HttpRunStateWriter("https://control.internal", lossy);
    const checker: CoordinatorDeps["checker"] = {
      async checkBatch({ entries }) {
        return {
          result: "pass",
          integrationBranch: "tanren/batch/ambiguous",
          authorityBinding: fakeBatchAuthorityBinding(entries),
        };
      },
    };
    const runner: CoordinatorDeps["runner"] = {
      async driveMerge() {
        return throwAmbiguousMerge("merge PUT may have landed; reconcile read failed");
      },
    };
    const coordinator = productionCoordinator(runtimePool(), writer, checker, runner);

    const first = await coordinator.coordinate(target.projectId);
    expect(first).toMatchObject({ holdReason: "infra_error", queueDepth: 1 });
    expect(first.retryAfterMs).toBeGreaterThan(0);
    expect(await queueState(ownerPool(), target)).toEqual({
      queue_status: "dequeued",
      dequeue_reason: "needs_attention",
      spec_status: "needs_attention",
    });
    await expect(coordinator.coordinate(target.projectId)).resolves.toMatchObject({
      holdReason: "empty",
      queueDepth: 0,
    });
    expect(await queueState(ownerPool(), otherTenant)).toEqual({
      queue_status: "queued",
      dequeue_reason: null,
      spec_status: "in_flight",
    });
    const events = await eventTypes(ownerPool(), target);
    expect(events.filter((event) => event === "merge.batch.infra_blocked")).toHaveLength(1);
    expect(events.filter((event) => event === "dag.spec.needs_attention")).toHaveLength(1);
    expect(events.filter((event) => event === "merge.dequeued")).toHaveLength(1);
  });

  it("a completed atomic park is a byte-stable downstream settlement no-op", async () => {
    const target = candidate("completed_park_replay");
    await seedCandidate(ownerPool(), target);
    const writer = new DirectRunStateWriter(orgScopingPool(runtimePool()));
    const park = await writer.parkRecoveryAndDequeue({
      orgId: target.orgId,
      projectId: target.projectId,
      queueId: target.queueId,
      runId: target.runId,
      specId: target.specId,
      message: "parked by base-shift recovery",
    });
    if (park.kind !== "parked") throw new Error(`expected parked, got ${park.kind}`);
    const before = await ownerPool().query<{ xmin: string }>("SELECT xmin::text FROM merge_queue WHERE queue_id = $1", [
      target.queueId,
    ]);
    const entry = {
      ...target,
      prUrl: `https://github.example/pulls/${target.queueId}`,
      prNumber: 23,
      dependsOn: [],
      priority: "normal" as const,
      orderKey: 1,
    };
    await expect(settleCompletedPark(runtimePool(), writer, entry, park)).resolves.toBe("dequeued");
    const after = await ownerPool().query<{ xmin: string }>("SELECT xmin::text FROM merge_queue WHERE queue_id = $1", [
      target.queueId,
    ]);
    expect(after.rows[0]?.xmin).toBe(before.rows[0]?.xmin);
    expect(await queueState(ownerPool(), target)).toEqual({
      queue_status: "dequeued",
      dequeue_reason: "needs_attention",
      spec_status: "needs_attention",
    });
    expect((await eventTypes(ownerPool(), target)).filter((event) => event === "merge.dequeued")).toHaveLength(1);
  });
});
