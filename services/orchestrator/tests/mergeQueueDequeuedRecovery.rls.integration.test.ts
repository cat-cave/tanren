// Real-PG regression for the native merge-queue recovery read. The worker runs as
// `tanren_dataplane`, while `recoverDequeuedCandidates` reads native-queue signals
// from `events` inside an org-scoped recovery transaction. If the data-plane role
// lacks SELECT on `events`, this path fails before RLS can evaluate with:
// `permission denied for table events`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { PgEventStore } from "../src/engine/eventStore.js";
import { selectNextMerge } from "../src/engine/contracts/mergeCoordinator.js";
import { PgMergeQueueModel } from "../src/engine/merge/coordinatorPg.js";
import { MERGE_CLAIM_LEASE_MS } from "../src/engine/merge/mergeClaimLease.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const DATAPLANE_ROLE = "tanren_dataplane";
const DATAPLANE_PASSWORD = process.env["TANREN_DATAPLANE_DB_PASSWORD"] ?? "tanren_dataplane";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_mq_recovery_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG = "org_mq_recovery";
const PROJECT = `project_${ORG}`;
const SPEC = `spec_${ORG}`;
const RUN = `run_${ORG}`;
const QUEUE = `mq_${ORG}`;
const PR_URL = "https://github.com/acme/native-queue-fixture/pull/15";
const OTHER_ORG = "org_mq_recovery_other";

describeDb("merge queue dequeued recovery under data-plane RLS (real PG)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let dataPlanePool: Pool;
  let systemPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    dataPlanePool = new Pool({ connectionString: withRole(ADMIN_URL, DATAPLANE_ROLE, DATAPLANE_PASSWORD, database) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) });
    setSystemPool(systemPool);

    for (const org of [ORG, OTHER_ORG]) {
      await ownerPool.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [org],
      );
    }
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'p', 'https://github.com/acme/native-queue-fixture.git', $2)`,
      [PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'ci', 'recover queue', 'in_flight')`,
      [SPEC, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'main', 'completed')`,
      [RUN, SPEC, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO merge_queue
         (queue_id, run_id, spec_id, project_id, org_id, status, dequeue_reason, pr_url, pr_number, settled_at)
       VALUES ($1, $2, $3, $4, $5, 'dequeued', 'blocked', $6, '15', now())`,
      [QUEUE, RUN, SPEC, PROJECT, ORG, PR_URL],
    );
    await runWithOrgScope(ownerPool, ORG, async (client) => {
      await new PgEventStore(client).append({
        runId: RUN,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "merge.dequeued",
        payload: {
          integration: "native_queue",
          reason: "blocked",
          prUrl: PR_URL,
          prNumber: 15,
          specId: SPEC,
          message: "blocked native-queue candidate",
        },
      });
    });
  }, 60_000);

  afterAll(async () => {
    resetSystemPool();
    await dataPlanePool?.end();
    await systemPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("allows the data-plane role to read event signals only through the active org scope", async () => {
    await expect(
      runWithOrgScope(dataPlanePool, ORG, (client) =>
        client.query("SELECT count(*)::int AS n FROM events WHERE project_id = $1", [PROJECT]),
      ),
    ).resolves.toMatchObject({ rows: [{ n: 1 }] });

    await expect(
      runWithOrgScope(dataPlanePool, OTHER_ORG, (client) =>
        client.query("SELECT count(*)::int AS n FROM events WHERE project_id = $1", [PROJECT]),
      ),
    ).resolves.toMatchObject({ rows: [{ n: 0 }] });
  });

  it("reports and recovers only stale pg merge claims", async () => {
    const claims = [
      { suffix: "fresh", queueId: "mq_pg_lease_fresh", claimSql: "now()" },
      {
        suffix: "stale",
        queueId: "mq_pg_lease_stale",
        claimSql: `now() - (${MERGE_CLAIM_LEASE_MS + 1}::bigint * interval '1 millisecond')`,
      },
      { suffix: "null", queueId: "mq_pg_lease_null", claimSql: "NULL" },
    ];

    for (const claim of claims) {
      await ownerPool.query(
        `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
         VALUES ($1, $2, $3, $4, 'pg lease recovery', 'in_flight')`,
        [`spec_pg_lease_${claim.suffix}`, PROJECT, ORG, `pg lease ${claim.suffix}`],
      );
      await ownerPool.query(
        `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
         VALUES ($1, $2, $3, $4, 'ci', 'main', 'completed')`,
        [`run_pg_lease_${claim.suffix}`, `spec_pg_lease_${claim.suffix}`, PROJECT, ORG],
      );
      await ownerPool.query(
        `INSERT INTO merge_queue
           (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number, claimed_at)
         VALUES ($1, $2, $3, $4, $5, 'merging', $6, $7, ${claim.claimSql})`,
        [
          claim.queueId,
          `run_pg_lease_${claim.suffix}`,
          `spec_pg_lease_${claim.suffix}`,
          PROJECT,
          ORG,
          `${PR_URL}-${claim.suffix}`,
          `15${claim.suffix.length}`,
        ],
      );
    }

    const queue = new PgMergeQueueModel(dataPlanePool);
    const snapshot = await queue.loadSnapshot(PROJECT);
    expect(snapshot.mergingInFlight).toBe(true);
    expect(snapshot.serializedRetryAfterMs).toBeDefined();
    expect(snapshot.serializedRetryAfterMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.serializedRetryAfterMs).toBeLessThanOrEqual(MERGE_CLAIM_LEASE_MS);

    const recovered = await queue.recoverStaleClaims(PROJECT);
    expect(recovered).toBe(2);

    const rows = await ownerPool.query<{
      queue_id: string;
      status: string;
      claimed_at: Date | null;
    }>(
      `SELECT queue_id, status, claimed_at
         FROM merge_queue
        WHERE queue_id = ANY($1::text[])
        ORDER BY queue_id`,
      [claims.map((claim) => claim.queueId)],
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ queue_id: "mq_pg_lease_fresh", status: "merging" }),
      { queue_id: "mq_pg_lease_null", status: "queued", claimed_at: null },
      { queue_id: "mq_pg_lease_stale", status: "queued", claimed_at: null },
    ]);
    expect(rows.rows[0]?.claimed_at).toBeInstanceOf(Date);
  });

  it("recovers a blocked dequeued row from the worker data-plane pool", async () => {
    const recovered = await new PgMergeQueueModel(dataPlanePool).recoverDequeuedCandidates(PROJECT);
    expect(recovered).toBe(1);

    const row = await ownerPool.query<{ status: string; dequeue_reason: string | null }>(
      "SELECT status, dequeue_reason FROM merge_queue WHERE queue_id = $1",
      [QUEUE],
    );
    expect(row.rows[0]).toMatchObject({ status: "queued", dequeue_reason: null });
  });

  it("does not satisfy a queued dependent until a held ancestor has a later merge.completed", async () => {
    const project = "project_held_resume";
    const parentSpec = "spec_held_parent";
    const parentRun = "run_held_parent";
    const childSpec = "spec_held_child";
    const childRun = "run_held_child";
    const childQueue = "mq_held_child";

    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'held resume', 'https://github.com/acme/native-queue-fixture.git', $2)`,
      [project, ORG],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'held parent', 'ancestor has unresolved hold', 'merged')`,
      [parentSpec, project, ORG],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status, depends_on)
       VALUES ($1, $2, $3, 'held child', 'dependent waits for parent', 'in_flight', $4)`,
      [childSpec, project, ORG, [parentSpec]],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'main', 'completed'),
              ($5, $6, $3, $4, 'ci', 'main', 'completed')`,
      [parentRun, parentSpec, project, ORG, childRun, childSpec],
    );
    await ownerPool.query(
      `INSERT INTO merge_queue
         (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, '16')`,
      [childQueue, childRun, childSpec, project, ORG, `${PR_URL}-held-child`],
    );
    await runWithOrgScope(ownerPool, ORG, async (client) => {
      await new PgEventStore(client).append({
        runId: parentRun,
        specId: parentSpec,
        projectId: project,
        eventType: "merge.speculative_held",
        payload: {
          prUrl: `${PR_URL}-held-parent`,
          prNumber: 17,
          integration: "native_queue",
          speculativeBase: "tanren/integ/spec_held_parent",
          unmergedAncestors: ["spec_grandparent"],
        },
      });
    });

    const queue = new PgMergeQueueModel(dataPlanePool);
    const heldSnapshot = await queue.loadSnapshot(project);
    expect(heldSnapshot.mergedSpecIds.has(parentSpec)).toBe(false);
    const heldSelection = selectNextMerge(heldSnapshot);
    expect(heldSelection).toMatchObject({
      holdReason: "all_blocked",
      blockedByDependency: [expect.objectContaining({ specId: childSpec })],
    });

    await runWithOrgScope(ownerPool, ORG, async (client) => {
      await new PgEventStore(client).append({
        runId: parentRun,
        specId: parentSpec,
        projectId: project,
        eventType: "merge.completed",
        payload: {
          prUrl: `${PR_URL}-held-parent`,
          prNumber: 17,
          integration: "native_queue",
          mergeSha: "parent-merge-sha",
        },
      });
    });

    const resumedSnapshot = await queue.loadSnapshot(project);
    expect(resumedSnapshot.mergedSpecIds.has(parentSpec)).toBe(true);
    expect(selectNextMerge(resumedSnapshot).next).toMatchObject({ queueId: childQueue, specId: childSpec });
  });
});
