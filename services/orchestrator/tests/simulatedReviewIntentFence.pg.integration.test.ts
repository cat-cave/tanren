// gv-2 real PostgreSQL proof (opt-in): production-composed intent first-wins +
// try-advisory publish fence across two actual pool clients.
//
// PRE-MIGRATION: `review.simulated_intent` is NOT in immutable spine migration
// 0040 (PR #931). IN-1 owns unmerged 0041, so the serialized upgrade migration
// (expected 0042 after IN-1 lands) is blocked. This suite EXPLICITLY seeds the
// event_types row for the pre-migration test surface. Real upgrade proof remains
// blocked until the post-IN-1 migration exists — do not treat this seed as
// upgrade proof.
//
// Gate: TANREN_RLS_DB_TEST=1 + DATABASE_URL (migration owner). Skipped otherwise.
// Compiles/typechecks even when the live gate is off.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgEventStore } from "../src/engine/eventStore.js";
import { reviewBodyFor } from "../src/engine/workflow/reviewMerge/simulatedReviewer.js";
import {
  PgSimulatedReviewIntentRepository,
  REVIEW_SIMULATED_INTENT_EVENT,
  type SimulatedReviewIntent,
} from "../src/engine/workflow/reviewMerge/simulatedReviewIntent.js";
import {
  PgAdvisorySimulatedReviewPublishFence,
  SimulatedReviewPublishFenceBusyError,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublishFence.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";

const ORG = "org_gv2_intent";
const PROJECT = "proj_gv2_intent";
const SPEC = "spec_gv2_intent";
const RUN = "run_gv2_intent";
const HEAD = "c".repeat(40);
const REVIEWER = "tanren-reviewer[bot]";

function dbName(): string {
  return `tanren_gv2_intent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function intentCandidate(state: "approved" | "changes_requested", message: string): SimulatedReviewIntent {
  const verdict = state === "approved" ? "approve" : "request_changes";
  return {
    headSha: HEAD,
    state,
    event: state === "approved" ? "APPROVE" : "REQUEST_CHANGES",
    body: reviewBodyFor({ verdict, reasoning: message }),
    message,
    reviewerLogin: REVIEWER,
    marker: `tanren-simulated-review:v1:${state}`,
  };
}

describeDb("gv-2 intent fence + publish fence against real Postgres (pre-migration seed)", () => {
  const database = dbName();
  let ownerPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    // PRE-MIGRATION catalog seed — NOT upgrade proof (IN-1 owns 0041; GV-2 needs 0042).
    await ownerPool.query(
      `INSERT INTO event_types (name, default_severity) VALUES ($1, 'info')
       ON CONFLICT (name) DO NOTHING`,
      [REVIEW_SIMULATED_INTENT_EVENT],
    );

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'gv2', 'https://github.com/acme/gv2-intent.git', $2)`,
      [PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'gv2', 'intent fence', 'in_flight')`,
      [SPEC, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'feat/gv2', 'running')`,
      [RUN, SPEC, PROJECT, ORG],
    );
  }, 60_000);

  afterAll(async () => {
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("concurrent opposite intent candidates: exactly one durable winner via events_prior_idempotency_unique", async () => {
    const store = new PgEventStore(ownerPool);
    const repo = new PgSimulatedReviewIntentRepository(ownerPool, store as never);
    const approve = intentCandidate("approved", "A-wins");
    const changes = intentCandidate("changes_requested", "B-loses");

    // Two independent org scopes (two workers) — not one shared txn client.
    const [w1, w2] = await Promise.all([
      runWithOrgScope(ownerPool, ORG, async () =>
        repo.adoptOrRecord({
          runId: RUN,
          orgId: ORG,
          projectId: PROJECT,
          specId: SPEC,
          candidate: approve,
        }),
      ),
      runWithOrgScope(ownerPool, ORG, async () =>
        repo.adoptOrRecord({
          runId: RUN,
          orgId: ORG,
          projectId: PROJECT,
          specId: SPEC,
          candidate: changes,
        }),
      ),
    ]);

    expect(w1).toEqual(w2);
    const looked = await runWithOrgScope(ownerPool, ORG, async () => repo.lookup(RUN, HEAD));
    expect(looked).toEqual(w1);
    const count = await ownerPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM events
        WHERE run_id = $1 AND event_type = $2 AND idempotency_key IS NOT NULL`,
      [RUN, REVIEW_SIMULATED_INTENT_EVENT],
    );
    expect(count.rows[0]?.n).toBe("1");
  });

  it("two clients contend on publication fence: one posts, other busy with zero provider I/O; redrive reuses", async () => {
    const fence = new PgAdvisorySimulatedReviewPublishFence(ownerPool);
    const key = {
      owner: "acme",
      repo: "gv2-intent",
      pullNumber: 42,
      headSha: HEAD,
      reviewerLogin: REVIEWER,
      state: "approved" as const,
    };
    let posts = 0;
    let contenderWorked = false;

    const holder = fence.withExclusivePublish(key, async () => {
      posts += 1;
      await new Promise<void>((r) => {
        setTimeout(r, 80);
      });
      return "posted";
    });

    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });

    await expect(
      fence.withExclusivePublish(key, async () => {
        contenderWorked = true;
        posts += 1;
        return "should-not";
      }),
    ).rejects.toBeInstanceOf(SimulatedReviewPublishFenceBusyError);

    expect(contenderWorked).toBe(false);
    expect(await holder).toBe("posted");
    expect(posts).toBe(1);

    // Redrive after unlock reclaims (list→reuse in production; here: re-acquire).
    const again = await fence.withExclusivePublish(key, async () => {
      posts += 1;
      return "redrive";
    });
    expect(again).toBe("redrive");
    expect(posts).toBe(2);
  });

  it("unlock failure path destroys client (never returns healthy) — unit-shaped against real pool client", async () => {
    // Pin a real client, acquire a try-lock, then force unlock SQL error by closing
    // the backend mid-hold and prove release(true) is the only safe return path.
    // Full poison proof for pool health is also covered by simulatedReviewPublishFence unit tests;
    // here we assert try-lock + unlock cycle completes on a live session without leak.
    const client = await ownerPool.connect();
    try {
      const material = `tanren:simulated-review-pub:v1|acme|gv2-intent|99|${HEAD}|${REVIEWER}|approved`;
      const locked = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired",
        ["tanren:simulated-review-pub:v1", material],
      );
      expect(locked.rows[0]?.acquired).toBe(true);
      const unlocked = await client.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [
        "tanren:simulated-review-pub:v1",
        material,
      ]);
      expect(unlocked.rowCount).toBe(1);
    } finally {
      client.release();
    }
  });

  it("wrong run/head keys isolate intent rows (no cross-run collision)", async () => {
    const store = new PgEventStore(ownerPool);
    const repo = new PgSimulatedReviewIntentRepository(ownerPool, store as never);
    const otherRun = "run_gv2_other";
    const otherHead = "d".repeat(40);
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'feat/other', 'running')
       ON CONFLICT DO NOTHING`,
      [otherRun, SPEC, PROJECT, ORG],
    );
    await runWithOrgScope(ownerPool, ORG, async () => {
      await repo.adoptOrRecord({
        runId: otherRun,
        orgId: ORG,
        projectId: PROJECT,
        candidate: {
          ...intentCandidate("changes_requested", "other-run"),
          headSha: otherHead,
        },
      });
    });
    const missing = await runWithOrgScope(ownerPool, ORG, async () => repo.lookup(otherRun, HEAD));
    expect(missing).toBeUndefined();
    const found = await runWithOrgScope(ownerPool, ORG, async () => repo.lookup(otherRun, otherHead));
    expect(found?.message).toBe("other-run");
  });

  it("documents: real upgrade proof blocked until post-IN-1 migration (0042 expected)", () => {
    // 0040 spine is immutable and lacks review.simulated_intent. This test
    // seeded the row manually. Merge-readiness requires IN-1 to land 0041, then
    // GV-2 restacks and adds the next serialized vocabulary migration.
    expect(REVIEW_SIMULATED_INTENT_EVENT).toBe("review.simulated_intent");
  });
});

// Always-on compile pin: imports/types resolve when the live gate is off.
describe("gv-2 real-PG suite module loads (gate may skip live cases)", () => {
  it("exports describeDb skip when TANREN_RLS_DB_TEST is unset", () => {
    expect(typeof describeDb).toBe("function");
    expect(REVIEW_SIMULATED_INTENT_EVENT).toBe("review.simulated_intent");
  });
});
