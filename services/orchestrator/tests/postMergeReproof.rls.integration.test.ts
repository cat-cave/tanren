// rv-19 real-Postgres proof for the post-merge production re-proof + rollback hook.
// Every decisive write runs through the restricted non-superuser `tanren_app` role
// (rolsuper=false AND rolbypassrls=false), so the rollback-actually-reverts guarantee,
// the promote path, idempotency, and org isolation are proven on the live RLS-forced
// substrate. Gated on TANREN_RLS_DB_TEST like every peer *.rls.integration test; runs
// in the `smoke-rls-post-merge-reproof` recipe rather than the DB-less unit phase.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InvalidReleaseStateTransitionError,
  ReleaseInstancesStore,
} from "../src/engine/repositories/releaseInstances.js";
import {
  PostMergeReproofCoordinator,
  reproofAlreadySettled,
  type SettleReproofInput,
} from "../src/engine/verification/postMergeReproof/coordinator.js";
import type { ResolutionStage, ResolutionStageKind } from "../src/engine/contracts/resolutionStage.js";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createProductionVerificationRoutes } from "../src/routes/issueLoops/productionVerification.js";
import {
  ADMIN_URL,
  APP_USER,
  connectionUrl,
  deployEventCount,
  DIGEST_B,
  DIGEST_NEW,
  DIGEST_PRIOR,
  GIT_SHA,
  INCONCLUSIVE,
  latestLiveId,
  ORG_A,
  ORG_B,
  PRODUCT_FAILURE,
  PRODUCT_RESOLVED,
  PROJECT_A,
  PROJECT_B,
  reproofDatabaseName,
  reproofJob,
  seedOrg,
  seedRelease,
  stateOf,
} from "./helpers/reproofReleaseHarness.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const rolledBackCount = (app: Pool, orgId: string, projectId: string, deploymentId: string) =>
  deployEventCount(app, "deployment.rolled_back", orgId, projectId, deploymentId);
const promotedCount = (app: Pool, orgId: string, projectId: string, deploymentId: string) =>
  deployEventCount(app, "deployment.promoted", orgId, projectId, deploymentId);

describeDb("rv-19 post-merge re-proof + rollback — real Postgres end-to-end", () => {
  const database = reproofDatabaseName();
  let owner: Pool;
  let app: Pool;
  let coordinator: PostMergeReproofCoordinator;

  const settle = (input: SettleReproofInput) => coordinator.settle(input);

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, true) });
    await seedOrg(owner, ORG_A, PROJECT_A, [DIGEST_PRIOR, DIGEST_NEW]);
    await seedOrg(owner, ORG_B, PROJECT_B, [DIGEST_B]);
    // These rv-19 settlement fixtures intentionally do not materialize an
    // acceptance ledger; the completeness authority has its own DB integration
    // coverage. Keep this suite focused on the promote/rollback fence.
    coordinator = new PostMergeReproofCoordinator({
      pool: app,
      completenessChecker: {
        check: async () => ({ complete: true, runId: "fixture", requiredBehaviorRevisionCount: 1 }),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("runs the decisive writes as the non-superuser tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: APP_USER, rolsuper: false, rolbypassrls: false });
  });

  it("DECISIVE — a FAILED re-proof rolls the live pointer back to the prior known-good release", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "rb_prior",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "rb_broken",
      digest: DIGEST_NEW,
      state: "live",
      previous: "rb_prior",
    });
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("rb_broken");

    const decision = await settle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      releaseInstanceId: "rb_broken",
      result: PRODUCT_FAILURE,
    });
    expect(decision).toBe("rolled_back");

    // The live pointer now returns the PRIOR, not the broken new release.
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("rb_prior");
    expect(await stateOf(app, ORG_A, "rb_prior")).toBe("live");
    expect(await stateOf(app, ORG_A, "rb_broken")).toBe("superseded");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-rb_broken")).toBe(1);
  });

  it("a PASSED re-proof promotes the proven release (stays live) and records deployment.promoted", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "pr_live",
      digest: DIGEST_NEW,
      state: "live",
      previous: null,
      sourceRef: GIT_SHA,
    });
    const decision = await settle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      releaseInstanceId: "pr_live",
      result: PRODUCT_RESOLVED,
    });
    expect(decision).toBe("promoted");
    expect(await stateOf(app, ORG_A, "pr_live")).toBe("live");
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("pr_live");
    expect(await promotedCount(app, ORG_A, PROJECT_A, "deployment-pr_live")).toBe(1);
  });

  it("fail-closed — an INCONCLUSIVE re-proof neither promotes nor rolls back (release stays live)", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "hold_prior",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "hold_live",
      digest: DIGEST_NEW,
      state: "live",
      previous: "hold_prior",
    });
    const decision = await settle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      releaseInstanceId: "hold_live",
      result: INCONCLUSIVE,
    });
    expect(decision).toBe("held");
    expect(await stateOf(app, ORG_A, "hold_live")).toBe("live");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-hold_live")).toBe(0);
    expect(await promotedCount(app, ORG_A, PROJECT_A, "deployment-hold_live")).toBe(0);
  });

  it("DECISIVE (retry-route-rollback) — a product_failure via POST .../retry-verification rolls the live pointer back", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "rr_prior",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "rr_broken",
      digest: DIGEST_NEW,
      state: "live",
      previous: "rr_prior",
    });
    const routeActor: ActorContext = {
      userId: "operator",
      orgId: ORG_A,
      projectId: null,
      scopes: ["org:admin"],
      source: "session",
    };
    const httpApp = new Hono<ActorContextEnv>();
    httpApp.use("*", async (c, next) => {
      c.set("actor", routeActor);
      await next();
    });
    httpApp.route(
      "/v1/orgs",
      createProductionVerificationRoutes({
        // The DEFAULT reproofCoordinator (real, over this pool) settles the deploy side,
        // proving the manual retry path cannot complete a failure with the release left live.
        pool: app,
        contracts: {
          get: () => Promise.resolve({ id: "contract_a", projectId: PROJECT_A, issueLoopId: "loop_a" } as never),
        },
        enqueue: { enqueue: (input) => Promise.resolve({ id: input.id, created: true }) },
        jobId: () => "rjob_route_rb",
        executionLeaseOwner: () => "route_lease",
        authority: {
          authorize: () =>
            Promise.resolve({
              id: "rdec",
              decision: "authorized",
              inputSnapshotHash: `sha256:${"a".repeat(64)}`,
              reasons: [],
              created: true,
            }),
        },
        jobs: {
          claimById: (i) =>
            Promise.resolve(reproofJob("rr_broken", { id: i.id, orgId: i.orgId, leaseOwner: i.leaseOwner })),
          verifyActiveLease: (i) =>
            Promise.resolve(reproofJob("rr_broken", { id: i.id, orgId: i.orgId, leaseOwner: i.leaseOwner })),
          complete: () => Promise.resolve(true),
          release: () => Promise.resolve(true),
        },
        stages: new Map<ResolutionStageKind, ResolutionStage>([
          ["production", { kind: "production", run: () => Promise.resolve(PRODUCT_FAILURE) }],
        ]),
      }),
    );
    const res = await httpApp.request(`/v1/orgs/${ORG_A}/projects/${PROJECT_A}/issue-loops/loop_a/retry-verification`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractId: "contract_a", releaseInstanceId: "rr_broken", idempotencyKey: "op-retry-rb" }),
    });
    expect(res.status).toBe(200);
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("rr_prior");
    expect(await stateOf(app, ORG_A, "rr_broken")).toBe("superseded");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-rr_broken")).toBe(1);
  });

  it("crash-replay-idempotent — after a rollback the settled job short-circuits, never re-running the stage or double-rolling", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "cr_prior",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "cr_broken",
      digest: DIGEST_NEW,
      state: "live",
      previous: "cr_prior",
    });
    expect(
      await settle({ orgId: ORG_A, projectId: PROJECT_A, releaseInstanceId: "cr_broken", result: PRODUCT_FAILURE }),
    ).toBe("rolled_back");
    // The bound release is now demoted — a recovered job MUST short-circuit (the walker skips
    // the stage) rather than re-run bh-10's live-binding (which would throw and loop forever).
    expect(await reproofAlreadySettled(coordinator, reproofJob("cr_broken"))).toBe(true);
    // And a direct re-settle re-decides to a no-op exactly once (no throw, no double-rollback).
    expect(
      await settle({ orgId: ORG_A, projectId: PROJECT_A, releaseInstanceId: "cr_broken", result: PRODUCT_FAILURE }),
    ).toBe("noop");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-cr_broken")).toBe(1);
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("cr_prior");
  });

  it("concurrent-single-promote — concurrent product_resolved settles emit exactly ONE deployment.promoted", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "cp_live",
      digest: DIGEST_NEW,
      state: "live",
      previous: null,
      sourceRef: GIT_SHA,
    });
    const decisions = await Promise.all([
      settle({ orgId: ORG_A, projectId: PROJECT_A, releaseInstanceId: "cp_live", result: PRODUCT_RESOLVED }),
      settle({ orgId: ORG_A, projectId: PROJECT_A, releaseInstanceId: "cp_live", result: PRODUCT_RESOLVED }),
    ]);
    // The advisory lock serializes decide+act: exactly one promotes, the other reads the
    // committed event and no-ops — a single deployment.promoted regardless of the race.
    expect([...decisions].sort()).toEqual(["noop", "promoted"]);
    expect(await promotedCount(app, ORG_A, PROJECT_A, "deployment-cp_live")).toBe(1);
  });

  it("no-op-when-not-deployed — a re-proof with no LIVE production release settles as before (no deploy action)", async () => {
    // A pre-deploy / superseded binding has nothing to promote or roll back.
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "nd_built",
      digest: DIGEST_NEW,
      state: "built",
      previous: null,
    });
    expect(
      await settle({ orgId: ORG_A, projectId: PROJECT_A, releaseInstanceId: "nd_built", result: PRODUCT_FAILURE }),
    ).toBe("noop");
    expect(
      await settle({ orgId: ORG_A, projectId: PROJECT_A, releaseInstanceId: "nd_built", result: PRODUCT_RESOLVED }),
    ).toBe("noop");
    expect(await stateOf(app, ORG_A, "nd_built")).toBe("built");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-nd_built")).toBe(0);
    expect(await promotedCount(app, ORG_A, PROJECT_A, "deployment-nd_built")).toBe(0);
  });

  it("no-prior-needs-attention — a first-deploy product_failure (no prior) is needs_attention + completes, never a throw or spurious rollback", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "npa_live",
      digest: DIGEST_NEW,
      state: "live",
      previous: null,
    });
    const decision = await settle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      releaseInstanceId: "npa_live",
      result: PRODUCT_FAILURE,
    });
    expect(decision).toBe("needs_attention");
    // The broken release stays live only because there is nothing good to revert to; no
    // spurious deployment.rolled_back is recorded, and settle did NOT throw (no retry-loop).
    expect(await stateOf(app, ORG_A, "npa_live")).toBe("live");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-npa_live")).toBe(0);
  });

  it("non-prior-resurrect-rejected — a raw superseded→live transition of an arbitrary release is rejected at the store", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "nr_super",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        ReleaseInstancesStore.transition(client, { orgId: ORG_A, releaseInstanceId: "nr_super", state: "live" }),
      ),
    ).rejects.toBeInstanceOf(InvalidReleaseStateTransitionError);
    expect(await stateOf(app, ORG_A, "nr_super")).toBe("superseded");
  });

  it("org isolation — another org sees zero of this org's rollback records and release rows", async () => {
    await seedRelease(owner, {
      orgId: ORG_B,
      projectId: PROJECT_B,
      id: "b_live",
      digest: DIGEST_B,
      state: "live",
      previous: null,
    });
    const crossEvents = await runWithOrgScope(app, ORG_B, (client) =>
      client.query("SELECT id FROM events WHERE event_type = 'deployment.rolled_back' AND org_id = $1", [ORG_A]),
    );
    expect(crossEvents.rowCount).toBe(0);
    const crossReleases = await runWithOrgScope(app, ORG_B, (client) =>
      client.query("SELECT id FROM release_instances WHERE org_id = $1", [ORG_A]),
    );
    expect(crossReleases.rowCount).toBe(0);
  });
});
