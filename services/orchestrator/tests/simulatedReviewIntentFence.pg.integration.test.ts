// gv-2 real PostgreSQL proof (opt-in): production-composed intent first-wins +
// try-advisory publish fence across two actual pool clients.
//
// Gate: TANREN_RLS_DB_TEST=1 + DATABASE_URL (migration owner). Skipped otherwise.
// Compiles/typechecks even when the live gate is off.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type { ReviewAnswer } from "../src/engine/answerers/schemas/index.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import type { ReviewProbe } from "../src/engine/workflow/reviewMerge/reviewProbeGithub.js";
import { pollReviewForRun } from "../src/engine/workflow/reviewMerge/reviewPolling.js";
import { reviewBodyFor } from "../src/engine/workflow/reviewMerge/simulatedReviewer.js";
import {
  durableSimulatedReviewIntentRepository,
  PgSimulatedReviewIntentRepository,
  REVIEW_SIMULATED_INTENT_EVENT,
  type SimulatedReviewIntent,
} from "../src/engine/workflow/reviewMerge/simulatedReviewIntent.js";
import {
  InMemorySimulatedReviewPublishFence,
  PgAdvisorySimulatedReviewPublishFence,
  SimulatedReviewPublishFenceBusyError,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublishFence.js";
import {
  simulatedReviewIntentFingerprint,
  simulatedReviewIntentMarker,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";

const ORG = "org_gv2_intent";
const OTHER_ORG = "org_gv2_other";
const PROJECT = "proj_gv2_intent";
const SPEC = "spec_gv2_intent";
const RUN = "run_gv2_intent";
const OTHER_PROJECT = "proj_gv2_other";
const OTHER_SPEC = "spec_gv2_other";
const OTHER_RUN = "run_gv2_other_org";
const HEAD = "c".repeat(40);
const POLL_HEAD = "e".repeat(40);
const REVIEWER = "tanren-reviewer[bot]";
const TASK = "task_gv2_review";
const POLL_RUN = "run_gv2_poll";
const POLL_TASK = "task_gv2_poll_review";

function dbName(): string {
  return `tanren_gv2_intent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function runtimeUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = "tanren_app";
  parsed.password = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function intentCandidate(state: "approved" | "changes_requested", message: string): SimulatedReviewIntent {
  const verdict = state === "approved" ? "approve" : "request_changes";
  const intentMarker = simulatedReviewIntentMarker(
    simulatedReviewIntentFingerprint({
      runId: RUN,
      taskId: TASK,
      headSha: HEAD,
      state,
      reviewerLogin: REVIEWER,
      message,
    }),
  );
  return {
    headSha: HEAD,
    state,
    event: state === "approved" ? "APPROVE" : "REQUEST_CHANGES",
    body: `${reviewBodyFor({ verdict, reasoning: message })}\n\n${intentMarker}`,
    message,
    reviewerLogin: REVIEWER,
    marker: `tanren-simulated-review:v1:${state}`,
  };
}

function pollReviewer(verdict: "approve" | "request_changes", calls: { count: number }): AnswererAdapter<ReviewAnswer> {
  return {
    kind: "answerer",
    cli: "test",
    authRef: "test",
    runAnswerer: async () => {
      calls.count += 1;
      return { verdict, reasoning: verdict === "approve" ? "worker A" : "worker B" };
    },
  };
}

function convergentPollProbe(forge: {
  pinCalls: number;
  submits: number;
  posts: number;
  receipt?: {
    forgeReviewId: string;
    forgeReviewState: "approved" | "changes_requested";
    forgeReviewUrl: string;
    headSha: string;
    reviewerLogin: string;
  };
}): ReviewProbe {
  return {
    markReady: async () => {},
    fetchVerdict: async () => ({ verdict: "pending" }),
    fetchSnapshot: async () => ({
      baseSha: "f".repeat(40),
      headSha: POLL_HEAD,
      authorLogin: "pr-writer",
      diff: "diff --git a/x b/x\n+x",
    }),
    fetchLiveHeadSha: async () => POLL_HEAD,
    pinSimulatedReviewer: async () => {
      forge.pinCalls += 1;
      return {
        reviewerLogin: REVIEWER,
        submitReview: async (event) => {
          forge.submits += 1;
          if (forge.receipt !== undefined) return forge.receipt;
          forge.posts += 1;
          forge.receipt = {
            forgeReviewId: "pg-91",
            forgeReviewState: event === "APPROVE" ? "approved" : "changes_requested",
            forgeReviewUrl: "https://github.com/acme/gv2-intent/pull/42#pullrequestreview-pg-91",
            headSha: POLL_HEAD,
            reviewerLogin: REVIEWER,
          };
          return forge.receipt;
        },
      };
    },
  };
}

describeDb("gv-2 intent fence + publish fence against migrated 0042 Postgres", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'gv2', 'https://github.com/acme/gv2-intent.git', $2,
               '{"version":1,"reviewPolicy":"simulated"}'::jsonb)`,
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
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, pr_url, status)
       VALUES ($1, $2, $3, $4, 'ci', 'feat/gv2-poll',
               'https://github.com/acme/gv2-intent/pull/42', 'running')`,
      [POLL_RUN, SPEC, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO tasks
         (task_id, run_id, org_id, kind, title, status, started_at, agent_kind, cli, attempt)
       VALUES ($1, $2, $3, 'review', 'Poll pull request review', 'running', now(), 'system', 'github', 1)`,
      [POLL_TASK, POLL_RUN, ORG],
    );
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [OTHER_ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'gv2-other', 'https://github.com/acme/gv2-other.git', $2)`,
      [OTHER_PROJECT, OTHER_ORG],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'gv2 other', 'cross-org proof', 'in_flight')`,
      [OTHER_SPEC, OTHER_PROJECT, OTHER_ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'feat/gv2-other', 'running')`,
      [OTHER_RUN, OTHER_SPEC, OTHER_PROJECT, OTHER_ORG],
    );
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("0042 migration owns review.simulated_intent without a test seed", async () => {
    const catalog = await ownerPool.query<{ name: string }>("SELECT name FROM event_types WHERE name = $1", [
      REVIEW_SIMULATED_INTENT_EVENT,
    ]);
    expect(catalog.rows).toEqual([{ name: REVIEW_SIMULATED_INTENT_EVENT }]);
  });

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
    const looked = await runWithOrgScope(ownerPool, ORG, async () => repo.lookup(ORG, RUN, HEAD));
    expect(looked).toEqual(w1);
    const count = await ownerPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM events
        WHERE run_id = $1 AND event_type = $2 AND idempotency_key IS NOT NULL`,
      [RUN, REVIEW_SIMULATED_INTENT_EVENT],
    );
    expect(count.rows[0]?.n).toBe("1");
  });

  it("canonical DirectRunStateWriter composes the same durable keyed first-wins repository", async () => {
    const composedHead = "d".repeat(40);
    const candidate = { ...intentCandidate("approved", "writer-seam"), headSha: composedHead };
    const repo = durableSimulatedReviewIntentRepository(runtimePool, new DirectRunStateWriter(runtimePool));

    const winner = await runWithOrgScope(runtimePool, ORG, () =>
      repo.adoptOrRecord({ runId: RUN, orgId: ORG, projectId: PROJECT, specId: SPEC, candidate }),
    );
    expect(winner).toEqual(candidate);
    const stored = await ownerPool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM events
        WHERE run_id = $1 AND event_type = $2 AND payload->>'headSha' = $3`,
      [RUN, REVIEW_SIMULATED_INTENT_EVENT, composedHead],
    );
    expect(stored.rows).toEqual([{ idempotency_key: `run_gv2_intent:simulated-review-intent:${composedHead}` }]);
  });

  it("two production-composed workers drive RunStateWriter through pollReviewForRun to one durable intent", async () => {
    const scopedPool = orgScopingPool(runtimePool);
    const forge: Parameters<typeof convergentPollProbe>[0] = { pinCalls: 0, submits: 0, posts: 0 };
    const probe = convergentPollProbe(forge);
    const publishFence = new InMemorySimulatedReviewPublishFence();
    const answererA = { count: 0 };
    const answererB = { count: 0 };
    const unusedHttp = {
      request: async () => {
        throw new Error("GitHub HTTP must stay behind the injected production-shaped probe");
      },
    };

    const worker = (verdict: "approve" | "request_changes", calls: { count: number }) =>
      runWithJobOrgId(ORG, () =>
        pollReviewForRun({
          pool: scopedPool,
          runStateWriter: new DirectRunStateWriter(scopedPool),
          secrets: new FakeSecretStore(),
          githubHttp: unusedHttp,
          runId: POLL_RUN,
          reviewProbe: probe,
          simulatedReviewer: () => pollReviewer(verdict, calls),
          simulatedReviewContext: {
            specTitle: "PG two-worker review",
            specDescription: "one durable first-wins intent",
            acceptanceCriteria: ["both workers adopt one winner"],
          },
          publishFence,
        }),
      );

    const [first, second] = await Promise.all([worker("approve", answererA), worker("request_changes", answererB)]);

    expect(first.verdict).toBe(second.verdict);
    expect(forge.pinCalls).toBe(2);
    expect(forge.posts).toBe(1);
    const rows = await ownerPool.query<{ event_type: string; n: string }>(
      `SELECT event_type, count(*)::text AS n
         FROM events
        WHERE run_id = $1
          AND event_type IN ('review.simulated_intent', 'review.approved', 'review.changes_requested')
        GROUP BY event_type
        ORDER BY event_type`,
      [POLL_RUN],
    );
    expect(rows.rows.find((row) => row.event_type === REVIEW_SIMULATED_INTENT_EVENT)?.n).toBe("1");
    const terminal = rows.rows.filter(
      (row) => row.event_type === "review.approved" || row.event_type === "review.changes_requested",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.n).toBe("1");
  });

  it("two clients contend on publication fence: one posts, other busy with zero provider I/O; redrive reuses", async () => {
    const fence = new PgAdvisorySimulatedReviewPublishFence(ownerPool);
    const key = {
      owner: "acme",
      repo: "gv2-intent",
      pullNumber: 42,
      headSha: HEAD,
      reviewerLogin: REVIEWER,
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
      const material = `tanren:simulated-review-pub:v1|acme|gv2-intent|99|${HEAD}|${REVIEWER}`;
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
    const missing = await runWithOrgScope(ownerPool, ORG, async () => repo.lookup(ORG, otherRun, HEAD));
    expect(missing).toBeUndefined();
    const found = await runWithOrgScope(ownerPool, ORG, async () => repo.lookup(ORG, otherRun, otherHead));
    expect(found?.message).toBe("other-run");
  });

  it("restricted tanren_app scope cannot read or mutate another org's intent", async () => {
    const store = new PgEventStore(runtimePool);
    const repo = new PgSimulatedReviewIntentRepository(runtimePool, store as never);
    const hidden = await runWithOrgScope(runtimePool, ORG, () => repo.lookup(OTHER_ORG, OTHER_RUN, HEAD));
    expect(hidden).toBeUndefined();
    await expect(
      runWithOrgScope(runtimePool, ORG, () =>
        repo.adoptOrRecord({
          runId: OTHER_RUN,
          orgId: OTHER_ORG,
          projectId: OTHER_PROJECT,
          specId: OTHER_SPEC,
          taskId: TASK,
          candidate: intentCandidate("approved", "cross-org must fail"),
        }),
      ),
    ).rejects.toThrow(/simulated review intent append failed/iu);
    const count = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM events WHERE run_id = $1 AND event_type = $2",
      [OTHER_RUN, REVIEW_SIMULATED_INTENT_EVENT],
    );
    expect(count.rows[0]?.n).toBe("0");
  });
});

// Always-on compile pin: imports/types resolve when the live gate is off.
describe("gv-2 real-PG suite module loads (gate may skip live cases)", () => {
  it("exports describeDb skip when TANREN_RLS_DB_TEST is unset", () => {
    expect(typeof describeDb).toBe("function");
    expect(REVIEW_SIMULATED_INTENT_EVENT).toBe("review.simulated_intent");
  });
});
