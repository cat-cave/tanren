// rv-19 real-Postgres proof that the LIVE resolution walker path (not just the retry route)
// drives the deploy-side settlement end-to-end: a walker-driven product_failure with a prior
// release rolls the live pointer back, and a lease-recovered replay of an already-rolled-back
// job short-circuits BEFORE the stage/`requireLiveBinding` runs (never a double-rollback).
// Every write runs as the restricted tanren_app role. Gated on TANREN_RLS_DB_TEST; runs in the
// `smoke-rls-post-merge-reproof` recipe.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostMergeReproofCoordinator } from "../src/engine/verification/postMergeReproof/coordinator.js";
import { ResolutionDagWalker } from "../src/engine/dag/resolutionDagWalker.js";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import type { ResolutionAuthority } from "../src/engine/contracts/resolutionAuthority.js";
import type { ResolutionStage, ResolutionStageKind } from "../src/engine/contracts/resolutionStage.js";
import {
  ADMIN_URL,
  connectionUrl,
  deployEventCount,
  DIGEST_NEW,
  DIGEST_PRIOR,
  latestLiveId,
  ORG_A,
  PRODUCT_FAILURE,
  PROJECT_A,
  reproofDatabaseName,
  seedLoopAndContract,
  seedOrg,
  seedRelease,
  stateOf,
} from "./helpers/reproofReleaseHarness.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const rolledBackCount = (app: Pool, orgId: string, projectId: string, deploymentId: string) =>
  deployEventCount(app, "deployment.rolled_back", orgId, projectId, deploymentId);

const authorizedAuthority = (): ResolutionAuthority => ({
  authorize: () =>
    Promise.resolve({
      id: "rdec_ok",
      decision: "authorized",
      inputSnapshotHash: `sha256:${"a".repeat(64)}`,
      reasons: [],
      created: true,
    }),
  waive: () => Promise.reject(new Error("walker cannot waive")),
});

const jobState = (app: Pool, orgId: string, id: string): Promise<string | undefined> =>
  runWithOrgScope(app, orgId, async (client) => {
    const rows = await client.query<{ state: string }>(
      "SELECT state FROM resolution_jobs WHERE org_id = $1 AND id = $2",
      [orgId, id],
    );
    return rows.rows[0]?.state;
  });

const productionStage = (counter: { runs: number }): ResolutionStage => ({
  kind: "production",
  run: () => {
    counter.runs += 1;
    return Promise.resolve(PRODUCT_FAILURE);
  },
});

describeDb("rv-19 walker-driven post-merge re-proof settlement — real Postgres", () => {
  const database = reproofDatabaseName();
  let owner: Pool;
  let app: Pool;
  let coordinator: PostMergeReproofCoordinator;

  const buildWalker = (stage: ResolutionStage, store: ResolutionJobStore, leaseOwner: string) =>
    new ResolutionDagWalker({
      store,
      orgIds: () => Promise.resolve([ORG_A]),
      stages: new Map<ResolutionStageKind, ResolutionStage>([["production", stage]]),
      authority: authorizedAuthority(),
      reproofCoordinator: coordinator,
      leaseOwner,
    });

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, true) });
    await seedOrg(owner, ORG_A, PROJECT_A, [DIGEST_PRIOR, DIGEST_NEW]);
    coordinator = new PostMergeReproofCoordinator({ pool: app });
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

  it("walker-e2e-rollback — a walker-driven product_failure with a prior release rolls the live pointer back", async () => {
    await seedLoopAndContract(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      loopId: "we_loop",
      contractId: "we_contract",
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "we_prior",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "we_broken",
      digest: DIGEST_NEW,
      state: "live",
      previous: "we_prior",
    });
    const store = new ResolutionJobStore(app);
    await store.enqueue({
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "rjob_we",
      issueLoopId: "we_loop",
      contractId: "we_contract",
      releaseInstanceId: "we_broken",
      stage: "production",
      idempotencyKey: "we_idem",
    });
    const counter = { runs: 0 };
    await buildWalker(productionStage(counter), store, "walker_we").tick();
    expect(counter.runs).toBe(1);
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("we_prior");
    expect(await stateOf(app, ORG_A, "we_broken")).toBe("superseded");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-we_broken")).toBe(1);
    expect(await jobState(app, ORG_A, "rjob_we")).toBe("completed");
  });

  it("walker-crash-replay-noop — replaying a rolled-back job short-circuits before the stage/requireLiveBinding, no double-rollback", async () => {
    await seedLoopAndContract(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      loopId: "cr_loop",
      contractId: "cr_contract",
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "crw_prior",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "crw_broken",
      digest: DIGEST_NEW,
      state: "live",
      previous: "crw_prior",
    });
    const store = new ResolutionJobStore(app);
    // First pass: a real walker rollback demotes crw_broken.
    await store.enqueue({
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "rjob_cr1",
      issueLoopId: "cr_loop",
      contractId: "cr_contract",
      releaseInstanceId: "crw_broken",
      stage: "production",
      idempotencyKey: "cr_idem_1",
    });
    await buildWalker(productionStage({ runs: 0 }), store, "walker_cr1").tick();
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("crw_prior");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-crw_broken")).toBe(1);
    // Replay: a lease-recovered job bound to the now-demoted release must short-circuit BEFORE
    // the stage runs (bh-10's requireLiveBinding is never reached) and never double-roll.
    await store.enqueue({
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "rjob_cr2",
      issueLoopId: "cr_loop",
      contractId: "cr_contract",
      releaseInstanceId: "crw_broken",
      stage: "production",
      idempotencyKey: "cr_idem_2",
    });
    const replayCounter = { runs: 0 };
    await buildWalker(productionStage(replayCounter), store, "walker_cr2").tick();
    expect(replayCounter.runs).toBe(0);
    expect(await jobState(app, ORG_A, "rjob_cr2")).toBe("completed");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-crw_broken")).toBe(1);
  });
});
