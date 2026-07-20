// cspell:ignore mqdlv headsha mainsha expmain
// mq-13 real-Postgres / RLS proof (gated on TANREN_RLS_DB_TEST; decisive writes run as the
// non-superuser tanren_app role). It proves the DB-touching invariants: the delivery claim is
// idempotent (exactly ONE row per completed group), finalize stamps a terminal receipt + emits
// the frozen delivery event, a cross-org read sees ZERO rows (FORCE RLS) and the route 404s, and
// the membership guard sees a group member (so the per-run delivery no-ops).

import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createLandGroupDeliveryRoutes } from "../src/routes/mergeQueue/landGroupDelivery.js";
import { PgLandGroupDeliveryStore } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryStore.js";
import { isLandGroupMember } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryReads.js";
import { LandGroupDeliveryLoop } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryLoop.js";
import type {
  GroupArtifact,
  GroupAttributionResult,
  GroupDeliveryDeployer,
  GroupDemoOutcome,
  GroupPreview,
  GroupProduction,
  GroupRegressionAttribution,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryCore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_mqdlv";
const OTHER_ORG = "org_mqdlv_other";
const PROJECT = "project_mqdlv";
const NODE = "inode_mqdlv";
const DECISION = "decision-inode_mqdlv-headsha";
const LG = "lg_mqdlv";
const RUN = "run_mqdlv";
const RUN_A = "run_mqdlv_a";
const SPEC = "spec_mqdlv";
const SPEC_A = "spec_mqdlv_a";
const MAIN = "mainsha_mqdlv";
const HEAD = "headsha_mqdlv";
const EXPECTED_MAIN = "expmain_mqdlv";
const ARTIFACT_DIGEST = `sha256:${"c".repeat(64)}`;

function databaseName(): string {
  return `tanren_mqdlv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
     VALUES ($1, 'p', 'https://github.com/acme/web.git', 'main', 'runner:v0', $2,
             '{"version":1,"deployProvider":"deploy.vercel","deployAppId":"app1"}'::jsonb)`,
    [PROJECT, ORG],
  );
  for (const [spec, run] of [
    [SPEC_A, RUN_A],
    [SPEC, RUN],
  ] as const) {
    await owner.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status, created_at)
       VALUES ($1,$2,$3,'t','d','[]'::jsonb,'in_flight','2026-07-20T00:00:00.000Z')`,
      [spec, PROJECT, ORG],
    );
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, pr_url)
       VALUES ($1,$2,$3,$4,'cli','tanren/x','completed','https://github.com/acme/web/pull/1')`,
      [run, spec, PROJECT, ORG],
    );
  }
  await owner.query(
    `INSERT INTO authority_decisions
       (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
        artifact_digest, proof_root, member_set_hash, policy_version, decision)
     VALUES ($1,$2,$3,$4,'integration_node',$5,$6,$7,$8,$9,'1','authorized')`,
    [ORG, PROJECT, DECISION, NODE, HEAD, EXPECTED_MAIN, ARTIFACT_DIGEST, `sha256:${"a".repeat(64)}`, "msh"],
  );
  await owner.query(
    `INSERT INTO land_groups (org_id, id, decision_id, expected_main_sha, authorized_sha, state, main_sha, reconcile_token)
     VALUES ($1,$2,$3,$4,$5,'completed',$6,$7)`,
    [ORG, LG, DECISION, EXPECTED_MAIN, HEAD, MAIN, `land-group-${LG}`],
  );
  for (const [key, run, spec] of [
    ["mk-a", RUN_A, SPEC_A],
    ["mk-b", RUN, SPEC],
  ] as const) {
    await owner.query(
      `INSERT INTO land_group_members (org_id, land_group_id, member_key, pr_number, run_id, spec_id, outcome)
       VALUES ($1,$2,$3,'1',$4,$5,'landed')`,
      [ORG, LG, key, run, spec],
    );
  }
  // The completed event lives on the TAIL run — the loop's detection entry point.
  await owner.query(
    `INSERT INTO events (run_id, spec_id, project_id, org_id, event_type, payload)
     VALUES ($1,$2,$3,$4,'merge.land_group.completed',$5::jsonb)`,
    [
      RUN,
      SPEC,
      PROJECT,
      ORG,
      JSON.stringify({
        projectId: PROJECT,
        landGroupId: LG,
        decisionId: DECISION,
        expectedMainSha: EXPECTED_MAIN,
        authorizedSha: HEAD,
        mainSha: MAIN,
        memberKeys: ["mk-a", "mk-b"],
      }),
    ],
  );
  // The preview + production release instances the fake deployer returns (the FK targets the
  // completed receipt's preview/production release ids reference).
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1,$2,0,'application/octet-stream','inline_pg',$3) ON CONFLICT (org_id, digest) DO NOTHING`,
    [ORG, ARTIFACT_DIGEST, Buffer.from([0])],
  );
  for (const [id, env, deploymentId, state] of [
    ["rel-preview", "preview", "dep-preview", "preview"],
    ["rel-prod", "production", "dep-prod", "live"],
  ] as const) {
    await owner.query(
      `INSERT INTO release_instances
         (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
          integration_node_id, state)
       VALUES ($1,$2,$3,'deploy.vercel','app1',$4,$5,$6,$7,$8,$9)`,
      [ORG, id, PROJECT, env, deploymentId, MAIN, ARTIFACT_DIGEST, NODE, state],
    );
  }
}

const ARTIFACT: GroupArtifact = { artifactDigest: ARTIFACT_DIGEST, deploymentId: "dep-build" };
const PREVIEW: GroupPreview = {
  release: { releaseInstanceId: "rel-preview", deploymentId: "dep-preview", artifactDigest: ARTIFACT_DIGEST },
  previewDeploymentId: "dep-preview",
};
const PRODUCTION: GroupProduction = {
  release: { releaseInstanceId: "rel-prod", deploymentId: "dep-prod", artifactDigest: ARTIFACT_DIGEST },
};

/** A happy-path fake deployer: build → preview → demo(ok) → promote → production demo(ok). */
class HappyFakeDeployer implements GroupDeliveryDeployer {
  // eslint-disable-next-line @typescript-eslint/require-await
  async buildArtifact(): Promise<GroupArtifact> {
    return ARTIFACT;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async applyPreview(): Promise<GroupPreview> {
    return PREVIEW;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async demo(): Promise<GroupDemoOutcome> {
    return { ok: true, reason: "" };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async teardownPreview(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async promote(): Promise<GroupProduction> {
    return PRODUCTION;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async currentPriorGood(): Promise<undefined> {
    return undefined;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async rollback(): Promise<void> {}
}

class NoopAttribution implements GroupRegressionAttribution {
  // eslint-disable-next-line @typescript-eslint/require-await
  async attribute(): Promise<GroupAttributionResult> {
    return { kind: "unattributed", reason: "n/a" };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async route(): Promise<void> {}
}

const ADMIN: ActorContext = {
  userId: "admin",
  orgId: ORG,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

function routeApp(pool: Pool, actor: ActorContext): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/orgs", createLandGroupDeliveryRoutes({ pool }));
  return app;
}

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

  async function rowCount(): Promise<number> {
    return runWithOrgScope(app, ORG, async (client) => {
      const r = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM land_group_delivery_loops WHERE org_id = $1",
        [ORG],
      );
      return Number(r.rows[0]?.n ?? "0");
    });
  }

  it("the membership guard sees a group member (per-run delivery no-ops)", async () => {
    const member = await runWithOrgScope(app, ORG, (client) => isLandGroupMember(client, ORG, RUN_A));
    const solo = await runWithOrgScope(app, ORG, (client) => isLandGroupMember(client, ORG, "run_not_in_group"));
    expect(member).toBe(true);
    expect(solo).toBe(false);
  });

  it("drives the FULL loop for a completed group → completed receipt + frozen event; a re-check is idempotent", async () => {
    const loop = new LandGroupDeliveryLoop({
      pool: app,
      deployer: new HappyFakeDeployer(),
      attribution: new NoopAttribution(),
      store: new PgLandGroupDeliveryStore(app),
    });
    await loop.check(RUN);
    expect(await rowCount()).toBe(1);
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
    expect(await rowCount()).toBe(1);
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
    expect(((await list.json()) as { deliveries: unknown[] }).deliveries).toHaveLength(1);

    const crossOrg = routeApp(app, { ...ADMIN, orgId: OTHER_ORG });
    const denied = await crossOrg.request(
      `/orgs/${OTHER_ORG}/projects/${PROJECT}/merge-queue/land-groups/${LG}/delivery`,
    );
    expect(denied.status).toBe(404);
  });
});
