// mq-13 Finding 2 proof (RLS, gated on TANREN_RLS_DB_TEST): the GROUP loop's evidence — the
// group's `deploy.verified` (via `groupDeployVerifiedPayload`) + `demo.completed` on the tail run
// — is EXACTLY what mq-15's `MergeTrainArtifactWatcher` needs to SEAL. With in-17 muted for group
// members this is the only evidence a land group gets, so this proves land groups no longer starve.

import { runWithOrgScope } from "@tanren/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MergeTrainArtifactWatcher } from "../src/engine/postMerge/mergeTrainArtifactWatcher.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import { groupDeployVerifiedPayload } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployerHelpers.js";
import { ProductionGroupDeliveryDeployer } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployer.js";
import { PgLandGroupDeliveryStore } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryStore.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import { TestProofSubstrate } from "./helpers/mergeTrainTestSubstrate.js";
import {
  basePlan,
  createRlsDatabase,
  insertEvents,
  LG,
  ORG,
  RUN,
  type RlsDatabase,
  TARGET,
} from "./helpers/landGroupDeliveryFixture.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

describeDb("mq-13 × mq-15 — a land group's group-loop evidence seals a merge-train artifact (Finding 2)", () => {
  let db: RlsDatabase;

  beforeAll(async () => {
    db = await createRlsDatabase();
  }, 60_000);

  afterAll(() => db.drop());

  it("HEALTH-GATED recovery: unhealthy live prod → NO deploy.verified; healthy → emits (idempotent) → mq-15 seals (Findings A + C)", async () => {
    const { app, owner } = db;
    const plan = { ...basePlan(), landGroupId: LG };
    const build = (status: number): ProductionGroupDeliveryDeployer =>
      new ProductionGroupDeliveryDeployer({
        pool: app,
        secrets: {} as never,
        transport: {} as never,
        eventStore: new PgEventStore(app),
        intentStore: new PgLandGroupDeliveryStore(app),
        // eslint-disable-next-line @typescript-eslint/require-await
        urlProbe: { probe: async () => status },
      });
    const countDeployVerified = async (): Promise<number> => {
      const r = await runWithOrgScope(app, ORG, (client) =>
        client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM events WHERE org_id = $1 AND run_id = $2 AND event_type = 'deploy.verified'",
          [ORG, RUN],
        ),
      );
      return r.rows[0]?.n ?? 0;
    };
    // rel-prod is DB-live (source_ref = MAIN) but its smoke probe returns 503 (UNHEALTHY). Recovery
    // MUST NOT emit deploy.verified — else mq-15 would seal a broken product on false evidence.
    await build(503).recoverDeployVerified({ plan, target: TARGET });
    expect(await countDeployVerified()).toBe(0);
    // The production recovers (HEALTHY 200) → recovery emits exactly once (Finding C: idempotent).
    const healthy = build(200);
    await healthy.recoverDeployVerified({ plan, target: TARGET });
    await healthy.recoverDeployVerified({ plan, target: TARGET });
    expect(await countDeployVerified()).toBe(1);
    // The recovered deploy.verified + demo.completed → mq-15 seals (the live group is not starved).
    await insertEvents(owner, RUN, [
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
  });

  it("mq-15 SEALS a merge-train artifact from the GROUP's deploy.verified + demo.completed", async () => {
    const { app, owner } = db;
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
});
