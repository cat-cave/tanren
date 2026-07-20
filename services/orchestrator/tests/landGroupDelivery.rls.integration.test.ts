// cspell:ignore mqdlv headsha mainsha expmain
// mq-13 real-Postgres / RLS proof (gated on TANREN_RLS_DB_TEST; decisive writes run as the
// non-superuser tanren_app role). It proves the DB-touching invariants: the delivery claim is
// idempotent (exactly ONE row per completed group), finalize stamps a terminal receipt + emits
// the frozen delivery event, a cross-org read sees ZERO rows (FORCE RLS) and the route 404s, and
// the membership guard sees a group member (so the per-run delivery no-ops).

import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgLandGroupDeliveryStore } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryStore.js";
import { isLandGroupMember } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryReads.js";
import { LandGroupDeliveryLoop } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryLoop.js";
import {
  groupDeployVerifiedPayload,
  ProductionGroupDeliveryDeployer,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployer.js";
import { MergeTrainArtifactWatcher } from "../src/engine/postMerge/mergeTrainArtifactWatcher.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import { TestProofSubstrate } from "./helpers/mergeTrainTestSubstrate.js";
import {
  ADMIN,
  ADMIN_URL,
  APP_PASSWORD,
  APP_ROLE,
  basePlan,
  connectionUrl,
  databaseName,
  HappyFakeDeployer,
  insertEvents,
  LG,
  LG_STALE,
  MAIN,
  NoopAttribution,
  ORG,
  OTHER_ORG,
  PROJECT,
  routeApp,
  RUN,
  RUN_A,
  RUN_FORMING,
  seedTenant,
  TARGET,
} from "./helpers/landGroupDeliveryFixture.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

describeDb("mq-13 land_group_delivery_loops — group delivery loop (RLS)", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    setSystemPool(owner);
    await seedTenant(owner);
  }, 60_000);

  afterAll(async () => {
    resetSystemPool();
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  });

  async function rowCount(landGroupId: string): Promise<number> {
    return runWithOrgScope(app, ORG, async (client) => {
      const r = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM land_group_delivery_loops WHERE org_id = $1 AND land_group_id = $2",
        [ORG, landGroupId],
      );
      return Number(r.rows[0]?.n ?? "0");
    });
  }

  it("the membership guard suppresses ONLY completed-group members; formed/solo members still deliver (Finding 3)", async () => {
    const completedMember = await runWithOrgScope(app, ORG, (client) => isLandGroupMember(client, ORG, RUN_A));
    const solo = await runWithOrgScope(app, ORG, (client) => isLandGroupMember(client, ORG, "run_not_in_group"));
    // Finding 3: a member of a NON-completed (forming) group is NOT suppressed — it keeps its
    // per-run delivery (the loop never delivers a non-completed group, so suppressing would
    // strand it with zero delivery forever).
    const formingMember = await runWithOrgScope(app, ORG, (client) => isLandGroupMember(client, ORG, RUN_FORMING));
    expect(completedMember).toBe(true);
    expect(solo).toBe(false);
    expect(formingMember).toBe(false);
  });

  it("currentPriorGood resolves the SUPERSEDED prior from the promote lineage, not latestLive (Finding 1)", async () => {
    const deployer = new ProductionGroupDeliveryDeployer({
      pool: app,
      secrets: {} as never,
      transport: {} as never,
      eventStore: {} as never,
    });
    const plan = { ...basePlan(), landGroupId: LG };
    // rel-prod (live) records rel-prior-P (now `superseded`) as its predecessor → the prior-good
    // is P, which a state='live' lookup would miss. A regression must roll back TO P.
    const prior = await deployer.currentPriorGood({ plan, target: TARGET, exceptReleaseInstanceId: "rel-prod" });
    expect(prior?.releaseInstanceId).toBe("rel-prior-P");
    // A release with NO predecessor (first-ever) → genuine no-prior-good → undefined (needs_attention).
    const none = await deployer.currentPriorGood({ plan, target: TARGET, exceptReleaseInstanceId: "rel-preview" });
    expect(none).toBeUndefined();
  });

  it("a STALE in_progress claim is reclaimable (takeover) and the new owner finishes (Finding 5)", async () => {
    // A dead owner left an in_progress row (token 'dead') that has not progressed within the
    // liveness lease (updated_at = 1 hour ago). A fresh claim TAKES IT OVER with a new token.
    await runWithOrgScope(app, ORG, (client) =>
      client.query(
        `INSERT INTO land_group_delivery_loops
           (org_id, id, project_id, land_group_id, main_sha, state, disposition, idempotency_key,
            fencing_token, updated_at)
         VALUES ($1,$2,$3,$4,$5,'in_progress','none',$6,'dead', now() - interval '1 hour')`,
        [ORG, `ldl-${LG_STALE}`, PROJECT, LG_STALE, MAIN, `key-${LG_STALE}`],
      ),
    );
    const store = new PgLandGroupDeliveryStore(app);
    const takeover = await store.claim({ orgId: ORG, projectId: PROJECT, landGroupId: LG_STALE, mainSha: MAIN });
    expect(takeover.kind).toBe("owned");
    if (takeover.kind !== "owned") throw new Error("expected takeover");
    expect(takeover.token).not.toBe("dead");
    // A FRESH (non-stale) in_progress claim by the dead token is NOT reclaimable (the new owner holds it).
    const staleRenew = await store.renewClaim(ORG, LG_STALE, "dead");
    expect(staleRenew).toBe(false);
    // The new owner renews + finalizes to a terminal state (the group no longer strands).
    expect(await store.renewClaim(ORG, LG_STALE, takeover.token)).toBe(true);
    await store.finalize({
      plan: { ...basePlan(), landGroupId: LG_STALE },
      token: takeover.token,
      outcome: {
        state: "needs_attention",
        disposition: "needs_attention",
        artifactDigest: null,
        previewReleaseInstanceId: null,
        productionReleaseInstanceId: null,
        rollbackReleaseInstanceId: null,
        attributedRunId: null,
      },
      reason: "reclaimed stale delivery",
    });
    const row = await runWithOrgScope(app, ORG, (client) =>
      PgLandGroupDeliveryStore.getByLandGroup(client, ORG, PROJECT, LG_STALE),
    );
    expect(row?.state).toBe("needs_attention");
  });

  it("mq-15 SEALS a merge-train artifact from the GROUP's deploy.verified + demo.completed (Finding 2)", async () => {
    // The group loop emits the group's deploy.verified (via groupDeployVerifiedPayload) +
    // demo.completed on the tail run. With in-17 muted for group members, this is the ONLY
    // evidence a land group gets — mq-15 must be able to seal from it (else land groups starve).
    const plan = { ...basePlan(), landGroupId: LG };
    const deployVerified = groupDeployVerifiedPayload(plan, TARGET, {
      deploymentId: "dep-prod",
      url: "https://app1.example.com",
      state: "live",
      smokeStatus: 200,
    });
    await insertEvents(owner, RUN, [
      ["deploy.verified", deployVerified],
      ["demo.completed", { surfaceKind: "web_url", behaviorCount: 3, passed: 3, failed: 0 }],
    ]);
    const cas = new PgCasByteStore(app);
    const substrate = new TestProofSubstrate(app, cas);
    const watcher = new MergeTrainArtifactWatcher({ pool: app, proofSubstrate: substrate, casByteStore: cas });
    await watcher.check(RUN);
    const sealed = await runWithOrgScope(app, ORG, (client) =>
      client.query<{ land_group_id: string }>(
        "SELECT land_group_id FROM merge_train_artifacts WHERE org_id = $1 AND land_group_id = $2",
        [ORG, LG],
      ),
    );
    expect(sealed.rows).toHaveLength(1);
    expect(sealed.rows[0]?.land_group_id).toBe(LG);
  });

  it("drives the FULL loop for a completed group → completed receipt + frozen event; a re-check is idempotent", async () => {
    const loop = new LandGroupDeliveryLoop({
      pool: app,
      deployer: new HappyFakeDeployer(),
      attribution: new NoopAttribution(),
      store: new PgLandGroupDeliveryStore(app),
    });
    await loop.check(RUN);
    expect(await rowCount(LG)).toBe(1);
    const row = await runWithOrgScope(app, ORG, (client) =>
      PgLandGroupDeliveryStore.getByLandGroup(client, ORG, PROJECT, LG),
    );
    expect(row?.state).toBe("completed");
    expect(row?.productionReleaseInstanceId).toBe("rel-prod");
    expect(row?.receipt?.schemaVersion).toBe("land_group_delivery.v1");
    const event = await runWithOrgScope(app, ORG, (client) =>
      client.query<{ payload: { receiptId: string } }>(
        "SELECT payload FROM events WHERE org_id = $1 AND event_type = 'merge.land_group.delivery.completed'",
        [ORG],
      ),
    );
    expect(event.rows).toHaveLength(1);
    // A re-check is a clean idempotent no-op — still exactly ONE row, still completed.
    await loop.check(RUN);
    expect(await rowCount(LG)).toBe(1);
  });

  it("FORCE RLS: a cross-org scope sees ZERO delivery rows", async () => {
    const crossOrgRows = await runWithOrgScope(app, OTHER_ORG, async (client) => {
      const r = await client.query("SELECT id FROM land_group_delivery_loops WHERE land_group_id = $1", [LG]);
      return r.rows.length;
    });
    expect(crossOrgRows).toBe(0);
  });

  it("route serves the delivery timeline to the owner + 404s cross-org", async () => {
    const owned = routeApp(app, ADMIN);
    const single = await owned.request(`/orgs/${ORG}/projects/${PROJECT}/merge-queue/land-groups/${LG}/delivery`);
    expect(single.status).toBe(200);
    expect(((await single.json()) as { delivery: { state: string } }).delivery.state).toBe("completed");
    const list = await owned.request(`/orgs/${ORG}/projects/${PROJECT}/merge-queue/land-group-deliveries`);
    expect(list.status).toBe(200);
    const deliveries = ((await list.json()) as { deliveries: { landGroupId: string }[] }).deliveries;
    expect(deliveries.some((d) => d.landGroupId === LG)).toBe(true);

    const crossOrg = routeApp(app, { ...ADMIN, orgId: OTHER_ORG });
    const denied = await crossOrg.request(
      `/orgs/${OTHER_ORG}/projects/${PROJECT}/merge-queue/land-groups/${LG}/delivery`,
    );
    expect(denied.status).toBe(404);
  });
});
