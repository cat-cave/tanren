// mq-13 Finding 2 proof (RLS, gated on TANREN_RLS_DB_TEST): the GROUP loop's evidence — the
// group's `deploy.verified` (via `groupDeployVerifiedPayload`) + `demo.completed` on the tail run
// — is EXACTLY what mq-15's `MergeTrainArtifactWatcher` needs to SEAL. With in-17 muted for group
// members this is the only evidence a land group gets, so this proves land groups no longer starve.

import { runWithOrgScope } from "@tanren/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MergeTrainArtifactWatcher } from "../src/engine/postMerge/mergeTrainArtifactWatcher.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import { groupDeployVerifiedPayload } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployerHelpers.js";
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
