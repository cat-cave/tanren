// cspell:ignore mqdlv headsha mainsha expmain
// mq-13 real-Postgres / RLS proof (gated on TANREN_RLS_DB_TEST; decisive writes run as the
// non-superuser tanren_app role). It proves the DB-touching invariants: the delivery claim is
// idempotent (exactly ONE row per completed group), finalize stamps a terminal receipt + emits
// the frozen delivery event, a cross-org read sees ZERO rows (FORCE RLS) and the route 404s, and
// the membership guard sees a group member (so the per-run delivery no-ops).

import { runWithOrgScope } from "@tanren/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgLandGroupDeliveryStore } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryStore.js";
import { isLandGroupMember } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryReads.js";
import { LandGroupDeliveryLoop } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryLoop.js";
import { ProductionGroupDeliveryDeployer } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployer.js";
import { startClaimHeartbeat } from "../src/engine/postMerge/landGroupDelivery/claimHeartbeat.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import type { DeployAdapter } from "../src/engine/contracts/deployAdapter.js";
import {
  ADMIN,
  ARTIFACT_INTENT,
  basePlan,
  createRlsDatabase,
  delay,
  HappyFakeDeployer,
  LG,
  LG_HB,
  LG_INTENT,
  LG_STALE,
  MAIN,
  MAIN_INTENT,
  NoopAttribution,
  ORG,
  OTHER_ORG,
  PassingA3Gate,
  PROJECT,
  routeApp,
  RUN,
  RUN_A,
  RUN_FORMING,
  type RlsDatabase,
  TARGET,
} from "./helpers/landGroupDeliveryFixture.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

describeDb("mq-13 land_group_delivery_loops — group delivery loop (RLS)", () => {
  let db: RlsDatabase;
  let app: Pool;

  beforeAll(async () => {
    db = await createRlsDatabase();
    app = db.app;
  }, 60_000);

  afterAll(() => db.drop());

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

  it("idempotent promote NO-OP: no re-deploy AND deploy.verified emitted for the already-live group (Findings A + B)", async () => {
    // rel-prod is already the live production release for THIS group (artifact + main SHA). A
    // takeover's re-promote must detect the committed release, NEVER call adapter.promote again,
    // AND ensure deploy.verified is emitted (Finding B — the prior owner may have died before it).
    let promoteCalls = 0;
    const guardAdapter = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async promote() {
        promoteCalls += 1;
        throw new Error("adapter.promote MUST NOT be called on the idempotent path");
      },
    } as unknown as DeployAdapter;
    const deployer = new ProductionGroupDeliveryDeployer({
      pool: app,
      secrets: {} as never,
      transport: {} as never,
      eventStore: new PgEventStore(app),
      deployAdapter: guardAdapter,
      // eslint-disable-next-line @typescript-eslint/require-await
      urlProbe: { probe: async () => 200 },
    });
    const outcome = await deployer.promote({
      plan: { ...basePlan(), landGroupId: LG },
      target: TARGET,
      artifact: { artifactDigest: `sha256:${"c".repeat(64)}`, deploymentId: "dep-build" },
      preview: {
        release: {
          releaseInstanceId: "rel-preview",
          deploymentId: "dep-preview",
          artifactDigest: `sha256:${"c".repeat(64)}`,
        },
        previewDeploymentId: "dep-preview",
      },
      heartbeat: async () => {
        /* still owned */
      },
    });
    // NO re-promote — the committed live release was detected
    expect(promoteCalls).toBe(0);
    expect(outcome.kind).toBe("promoted");
    if (outcome.kind !== "promoted") throw new Error("expected promoted");
    expect(outcome.production.release.releaseInstanceId).toBe("rel-prod");
    // Finding B: the no-op path emitted deploy.verified for the tail run (mq-15 can now seal).
    const dv = await runWithOrgScope(app, ORG, (client) =>
      client.query("SELECT 1 FROM events WHERE org_id = $1 AND run_id = $2 AND event_type = 'deploy.verified'", [
        ORG,
        RUN,
      ]),
    );
    expect(dv.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("DEFINITIVE no-double-deploy: promote intent present without completion → DEGRADE, adapter.promote NOT called (Finding A)", async () => {
    // Owner A wrote the promote INTENT then fired the external promote (promoteCalls would be 1
    // out-of-band) and DIED before the DB live-release committed. Simulate: an in_progress claim
    // for LG_INTENT with promote_intent_at SET, and NO committed live release for its artifact.
    await runWithOrgScope(app, ORG, (client) =>
      client.query(
        `INSERT INTO land_group_delivery_loops
           (org_id, id, project_id, land_group_id, main_sha, state, disposition, idempotency_key,
            fencing_token, promote_intent_at)
         VALUES ($1,$2,$3,$4,$5,'in_progress','none',$6,'tokA', now())`,
        [ORG, `ldl-${LG_INTENT}`, PROJECT, LG_INTENT, MAIN_INTENT, `key-${LG_INTENT}`],
      ),
    );
    let promoteCalls = 0;
    const guardAdapter = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async promote() {
        promoteCalls += 1;
        throw new Error("adapter.promote MUST NOT be called after an ambiguous intent");
      },
    } as unknown as DeployAdapter;
    const deployer = new ProductionGroupDeliveryDeployer({
      pool: app,
      secrets: {} as never,
      transport: {} as never,
      eventStore: new PgEventStore(app),
      deployAdapter: guardAdapter,
      intentStore: new PgLandGroupDeliveryStore(app),
    });
    // B takes over and re-drives promote. The intent marker (no committed live release for THIS
    // artifact/main SHA) ⇒ AMBIGUOUS ⇒ B does NOT re-fire the external promote.
    const outcome = await deployer.promote({
      plan: { ...basePlan(), landGroupId: LG_INTENT, mainSha: MAIN_INTENT },
      target: TARGET,
      artifact: { artifactDigest: ARTIFACT_INTENT, deploymentId: "dep-build-intent" },
      preview: {
        release: {
          releaseInstanceId: "rel-prev-intent",
          deploymentId: "dep-prev-intent",
          artifactDigest: ARTIFACT_INTENT,
        },
        previewDeploymentId: "dep-prev-intent",
      },
      token: "tokB",
      heartbeat: async () => {
        /* still owned */
      },
    });
    // degrade — never re-fire; B did NOT call adapter.promote (no double external deploy)
    expect(outcome.kind).toBe("ambiguous");
    expect(promoteCalls).toBe(0);
  });

  it("orphaned preview reconcile: preview intent present without a persisted preview → DEGRADE (Finding D)", async () => {
    // Mark a preview intent on LG_INTENT's row (created by the promote-intent test) with NO persisted
    // preview release for its artifact — an orphaned external deploy from a dead owner.
    await runWithOrgScope(app, ORG, (client) =>
      client.query(
        "UPDATE land_group_delivery_loops SET preview_intent_at = now() WHERE org_id = $1 AND land_group_id = $2",
        [ORG, LG_INTENT],
      ),
    );
    let previewFired = false;
    const guardAdapter = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async applyPreview() {
        previewFired = true;
        throw new Error("adapter.applyPreview MUST NOT re-fire after an orphaned preview intent");
      },
    } as unknown as DeployAdapter;
    const deployer = new ProductionGroupDeliveryDeployer({
      pool: app,
      secrets: {} as never,
      transport: {} as never,
      eventStore: new PgEventStore(app),
      deployAdapter: guardAdapter,
      intentStore: new PgLandGroupDeliveryStore(app),
    });
    const outcome = await deployer.applyPreview({
      plan: { ...basePlan(), landGroupId: LG_INTENT, mainSha: MAIN_INTENT },
      target: TARGET,
      artifact: { artifactDigest: ARTIFACT_INTENT, deploymentId: "dep-build-intent" },
      token: "tokB",
      heartbeat: async () => {
        /* still owned */
      },
    });
    // orphan reconcile — never apply a SECOND preview
    expect(outcome.kind).toBe("ambiguous");
    expect(previewFired).toBe(false);
  });

  it("FAIL-CLOSED intent seam: a deployer WITHOUT an intent store REFUSES to fire promote (Finding B)", async () => {
    // A mis-composed deployer (no intent store) must NOT fall through to firing the external promote
    // without an intent marker — that would re-open the double-deploy window. It aborts LOUD instead.
    let promoteCalls = 0;
    const guardAdapter = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async promote() {
        promoteCalls += 1;
        throw new Error("adapter.promote MUST NOT fire without an intent marker");
      },
    } as unknown as DeployAdapter;
    const deployer = new ProductionGroupDeliveryDeployer({
      pool: app,
      secrets: {} as never,
      transport: {} as never,
      eventStore: new PgEventStore(app),
      deployAdapter: guardAdapter,
      // NO intentStore — the mis-composition the seam must fail closed on.
    });
    await expect(
      deployer.promote({
        // A group with no live release for THIS main SHA (so it reaches the fire path).
        plan: { ...basePlan(), landGroupId: LG_INTENT, mainSha: MAIN_INTENT },
        target: TARGET,
        artifact: { artifactDigest: ARTIFACT_INTENT, deploymentId: "dep-build-b" },
        preview: {
          release: { releaseInstanceId: "rel-p-b", deploymentId: "dep-p-b", artifactDigest: ARTIFACT_INTENT },
          previewDeploymentId: "dep-p-b",
        },
        token: "tokB",
        heartbeat: async () => {
          /* still owned */
        },
      }),
    ).rejects.toThrow(/without an intent marker/u);
    // never fired the external promote
    expect(promoteCalls).toBe(0);
  });

  it("continuous heartbeat keeps a LIVE owner fresh (not taken over); a DEAD owner is reclaimed (Finding A)", async () => {
    const store = new PgLandGroupDeliveryStore(app);
    const ownerClaim = await store.claim({ orgId: ORG, projectId: PROJECT, landGroupId: LG_HB, mainSha: MAIN });
    expect(ownerClaim.kind).toBe("owned");
    if (ownerClaim.kind !== "owned") throw new Error("expected owned");
    const hb = startClaimHeartbeat({
      renewer: store,
      orgId: ORG,
      landGroupId: LG_HB,
      token: ownerClaim.token,
      intervalMs: 20,
    });
    // While the owner's heartbeat renews every 20ms, a concurrent worker with a SHORT 100ms lease
    // sees the claim FRESH → does NOT take over (a live owner is never taken over mid-work).
    await delay(180);
    const live = await store.claim({
      orgId: ORG,
      projectId: PROJECT,
      landGroupId: LG_HB,
      mainSha: MAIN,
      leaseInterval: "100 milliseconds",
    });
    expect(live.kind).toBe("exists");
    // The owner DIES (heartbeat stopped) → after the lease ages out, the claim is reclaimable.
    hb.stop();
    await delay(180);
    const reclaimed = await store.claim({
      orgId: ORG,
      projectId: PROJECT,
      landGroupId: LG_HB,
      mainSha: MAIN,
      leaseInterval: "100 milliseconds",
    });
    expect(reclaimed.kind).toBe("owned");
  });

  it("drives the FULL loop for a completed group → completed receipt + frozen event; a re-check is idempotent", async () => {
    const loop = new LandGroupDeliveryLoop({
      pool: app,
      deployer: new HappyFakeDeployer(),
      a3Gate: new PassingA3Gate(),
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
