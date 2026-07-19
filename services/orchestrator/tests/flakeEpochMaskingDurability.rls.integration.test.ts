// mq-7 DURABLE ANTI-MASKING proof (real Postgres, restricted tanren_app role). The blocker the
// audit found: the anti-masking guarantee must NOT depend on `actuateFlakeQuarantine` succeeding.
// If actuation throws (or is skipped) after a new-epoch `failed_product` verdict, NO `release` row
// is written and the STALE (older-generation) quarantine remains the behavior's latest transition.
// The OLD masking site (`isQuarantined`, epoch-blind) would then still SKIP bisecting the regressed
// behavior — masking a genuine regression behind a stale quarantine.
//
// This proves the DURABLE fix on the REAL store: the masking consumption is EPOCH-SCOPED. With a
// stale quarantine present and NO release row:
//   1. legacy `isQuarantined` returns TRUE  — the epoch-blind check (what WOULD have masked).
//   2. `isQuarantinedInEpoch(NEW_EPOCH)` returns FALSE — the stale quarantine does NOT mask the new
//      generation; `isQuarantinedInEpoch(OLD_EPOCH)` returns TRUE — it masks only its own epoch.
//   3. `recordRegressionBisections`, given the REAL store as its epoch-scoped reader and a NEW_EPOCH
//      regression result, PROCEEDS to bisect (the invariant: a new-epoch consistent_failure is never
//      masked, even though the actuator never wrote the release row).
//   4. Cross-org reads see ZERO rows (RLS deny-by-default).
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBehaviorQuarantineStore } from "../src/engine/repositories/behaviorQuarantines.js";
import { FLAKE_CLASSIFIER_ACTOR } from "../src/engine/verification/acceptance/flakeQuarantineActuator.js";
import {
  recordRegressionBisections,
  type BisectionResult,
  type RegressionBisectionTrigger,
} from "../src/engine/verification/postMergeReproof/regressionBisection.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_mask_rls";
const OTHER_ORG = "org_mask_rls_other";
const PROJECT = "project_mask_rls";
const BR = "br_mask";
// The NEW code generation the regression is observed at = the observed epoch.
const NEW_EPOCH = `sha256:${"a".repeat(64)}`;
// The OLDER generation the STALE quarantine was proven in (no release row was ever written for the
// new epoch — the actuation-failed / skipped state).
const OLD_EPOCH = `sha256:${"b".repeat(64)}`;
const CTX = `sha256:${"c".repeat(64)}`;

function databaseName(): string {
  return `tanren_mask_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function connectionUrl(database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

async function seedTenant(owner: Pool): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [org],
    );
  }
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
}

describeDb("mq-7 durable anti-masking — a stale-epoch quarantine never masks a new-epoch regression", () => {
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
    await seedTenant(owner);

    // Seed ONLY a stale quarantine proven in OLD_EPOCH — NO release row for NEW_EPOCH (the state an
    // actuation failure/skip leaves behind). The behavior's latest transition stays `quarantine`.
    await new PgBehaviorQuarantineStore(app).recordTransition({
      orgId: ORG,
      projectId: PROJECT,
      behaviorRevisionId: BR,
      transition: "quarantine",
      classification: "flaky",
      reason: "seeded stale flake from an older generation (no release row written)",
      actor: FLAKE_CLASSIFIER_ACTOR,
      evidence: [
        { verdictId: "seed_pass", outcome: "passed" },
        { verdictId: "seed_fail", outcome: "failed_product" },
      ],
      contextHash: CTX,
      epoch: OLD_EPOCH,
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

  it("the epoch-BLIND legacy check would mask: isQuarantined = TRUE (the stale quarantine is still active)", async () => {
    const store = new PgBehaviorQuarantineStore(app);
    expect(await store.isQuarantined({ orgId: ORG, projectId: PROJECT }, BR)).toBe(true);
  });

  it("DURABLE: isQuarantinedInEpoch(NEW) = FALSE (stale ≠ observed), isQuarantinedInEpoch(OLD) = TRUE (own epoch)", async () => {
    const store = new PgBehaviorQuarantineStore(app);
    // The stale quarantine belongs to OLD_EPOCH — it masks NOTHING in the new generation.
    expect(await store.isQuarantinedInEpoch({ orgId: ORG, projectId: PROJECT }, BR, NEW_EPOCH)).toBe(false);
    // It still masks observations within its OWN epoch (a same-generation flake is not bisected).
    expect(await store.isQuarantinedInEpoch({ orgId: ORG, projectId: PROJECT }, BR, OLD_EPOCH)).toBe(true);
  });

  it("DURABLE (set seam): readActiveQuarantinedBehaviorsInEpoch excludes the stale quarantine from the new epoch", async () => {
    const store = new PgBehaviorQuarantineStore(app);
    const inNew = await store.readActiveQuarantinedBehaviorsInEpoch({ orgId: ORG, projectId: PROJECT }, NEW_EPOCH);
    const inOld = await store.readActiveQuarantinedBehaviorsInEpoch({ orgId: ORG, projectId: PROJECT }, OLD_EPOCH);
    expect(inNew.has(BR)).toBe(false);
    expect(inOld.has(BR)).toBe(true);
  });

  it("INVARIANT: recordRegressionBisections BISECTS the new-epoch regression despite the stale quarantine + no release row", async () => {
    const store = new PgBehaviorQuarantineStore(app);
    const bisectCalls: string[] = [];
    const bisector = {
      bisect(trigger: RegressionBisectionTrigger): Promise<BisectionResult> {
        bisectCalls.push(trigger.behaviorRevisionId);
        return Promise.resolve({ status: "inconclusive" } as BisectionResult);
      },
    };
    const results = await recordRegressionBisections(
      bisector,
      {
        decision: "recorded",
        // The NEW generation the regression was recorded at (the observed epoch).
        artifactDigest: NEW_EPOCH,
        verdicts: [{ behaviorRevisionId: BR, verdictId: "v_new_reg", outcome: "failed_product" }],
      },
      { orgId: ORG, projectId: PROJECT, releaseInstanceId: "ri_mask_live" },
      store,
    );
    // The stale (OLD_EPOCH) quarantine did NOT mask the NEW_EPOCH regression — bisection proceeded.
    expect(bisectCalls).toEqual([BR]);
    expect(results).toHaveLength(1);
  });

  it("org isolation: another org sees ZERO of this org's quarantine transitions (RLS deny-by-default)", async () => {
    const foreign = await runWithOrgScope(app, OTHER_ORG, async (client) => {
      const rows = await client.query<{ n: string }>("SELECT count(*) AS n FROM behavior_flake_quarantines", []);
      return Number(rows.rows[0]?.n ?? "0");
    });
    expect(foreign).toBe(0);
  });
});
