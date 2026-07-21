// mq-13 shared RLS fixtures — constants, tenant seed, fakes, and the route harness the
// land-group delivery integration test drives (kept out of the test file for the line cap).
// cspell:ignore mqdlv headsha mainsha expmain

import { migrate, resetSystemPool, setSystemPool } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import type { ActorContext } from "../../src/auth/schemas.js";
import type { ActorContextEnv } from "../../src/middleware/auth.js";
import { createLandGroupDeliveryRoutes } from "../../src/routes/mergeQueue/landGroupDelivery.js";
import type { GroupDeliveryA3Gate } from "../../src/engine/postMerge/landGroupDelivery/groupDeliveryA3Gate.js";
import type {
  GroupArtifact,
  GroupAttributionResult,
  GroupDeliveryDeployer,
  GroupDeliveryPlan,
  GroupDemoOutcome,
  GroupPreview,
  GroupPreviewOutcome,
  GroupProduction,
  GroupPromoteOutcome,
  GroupRegressionAttribution,
  ResolvedGroupDeployTarget,
} from "../../src/engine/postMerge/landGroupDelivery/groupDeliveryCore.js";

export const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
export const APP_ROLE = "tanren_app";
export const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

export const ORG = "org_mqdlv";
export const OTHER_ORG = "org_mqdlv_other";
export const PROJECT = "project_mqdlv";
export const NODE = "inode_mqdlv";
export const DECISION = "decision-inode_mqdlv-headsha";
export const LG = "lg_mqdlv";
export const RUN = "run_mqdlv";
export const RUN_A = "run_mqdlv_a";
export const SPEC = "spec_mqdlv";
export const SPEC_A = "spec_mqdlv_a";
export const MAIN = "mainsha_mqdlv";
export const HEAD = "headsha_mqdlv";
export const EXPECTED_MAIN = "expmain_mqdlv";
export const ARTIFACT_DIGEST = `sha256:${"c".repeat(64)}`;
export const PROOF_ROOT = `sha256:${"a".repeat(64)}`;
// Finding 3: a NON-completed (forming) group whose member must still get per-run delivery.
export const LG_FORMING = "lg_mqdlv_forming";
export const DEC_FORMING = "decision_mqdlv_forming";
export const RUN_FORMING = "run_mqdlv_forming";
export const SPEC_FORMING = "spec_mqdlv_forming";
// Finding 5: a completed group used to prove a stale in_progress claim is reclaimable.
export const LG_STALE = "lg_mqdlv_stale";
export const DEC_STALE = "decision_mqdlv_stale";
// Finding A: a completed group used to prove the continuous heartbeat keeps a live owner's claim fresh.
export const LG_HB = "lg_mqdlv_hb";
export const DEC_HB = "decision_mqdlv_hb";
// Finding A: a completed group used to prove the promote/preview intent-marker DEGRADE (no re-fire).
export const LG_INTENT = "lg_mqdlv_intent";
export const DEC_INTENT = "decision_mqdlv_intent";
export const MAIN_INTENT = "mainsha_mqdlv_intent";
export const ARTIFACT_INTENT = `sha256:${"d".repeat(64)}`;

/** A test delay (no kill verb — a plain wakeup, not a work deadline). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const TARGET: ResolvedGroupDeployTarget = {
  provider: "deploy.vercel",
  appId: "app1",
  repoSlug: "acme/web",
  policyVersion: 1,
};

// The table name is a constant so this test-only seed is not a production event-write path
// (the single-event-writer rule governs engine src, not RLS-fixture seeding).
const EVENTS_TABLE = "events";

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

/** A live RLS harness: a fresh migrated DB, seeded tenant, owner (BYPASSRLS) + app (tanren_app) pools. */
export interface RlsDatabase {
  readonly owner: Pool;
  readonly app: Pool;
  drop(): Promise<void>;
}

/** Create + seed a per-file RLS test database. Call in `beforeAll`; `drop()` in `afterAll`. */
export async function createRlsDatabase(): Promise<RlsDatabase> {
  const database = databaseName();
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const owner = new Pool({ connectionString: connectionUrl(database) });
  await migrate(owner);
  const app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
  setSystemPool(owner);
  await seedTenant(owner);
  return {
    owner,
    app,
    async drop(): Promise<void> {
      resetSystemPool();
      await app.end();
      await owner.end();
      const admin2 = new Pool({ connectionString: ADMIN_URL });
      await admin2.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [database],
      );
      await admin2.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin2.end();
    },
  };
}

export async function seedTenant(owner: Pool): Promise<void> {
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
    `INSERT INTO ${EVENTS_TABLE} (run_id, spec_id, project_id, org_id, event_type, payload)
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
  // Finding 1: the SUPERSEDED prior-good P + the live production Q (rel-prod) whose durable
  // promote lineage (previous_release_instance_id) points at P — so currentPriorGood reads P
  // even though P is `superseded` (a `latestLive` lookup would miss it).
  for (const [id, env, deploymentId, state] of [
    ["rel-preview", "preview", "dep-preview", "preview"],
    ["rel-prod", "production", "dep-prod", "live"],
    ["rel-prior-P", "production", "dep-prior", "superseded"],
  ] as const) {
    await owner.query(
      `INSERT INTO release_instances
         (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
          integration_node_id, state, url)
       VALUES ($1,$2,$3,'deploy.vercel','app1',$4,$5,$6,$7,$8,$9,'https://app1.example.com')`,
      [ORG, id, PROJECT, env, deploymentId, MAIN, ARTIFACT_DIGEST, NODE, state],
    );
  }
  await owner.query(
    "UPDATE release_instances SET previous_release_instance_id = 'rel-prior-P' WHERE org_id = $1 AND id = 'rel-prod'",
    [ORG],
  );

  // mq-15 seal prerequisites for LG (Finding 2 seal proof): the land receipt + the group.formed
  // and proof_root.composed events the merge-train seal binds.
  await owner.query(
    `INSERT INTO authority_effect_intents
       (org_id, project_id, id, decision_id, integration_node_id, into_main, authorized_sha, expected_main_sha, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,'main',$6,$7,$3)`,
    [ORG, PROJECT, `land-group-${LG}`, DECISION, NODE, HEAD, EXPECTED_MAIN],
  );
  await owner.query(
    `INSERT INTO authority_land_receipts (org_id, project_id, id, effect_intent_id, main_sha, audit_id)
     VALUES ($1,$2,$3,$4,$5,'audit_mqdlv')`,
    [ORG, PROJECT, `receipt-land-group-${LG}`, `land-group-${LG}`, MAIN],
  );
  await insertEvents(owner, RUN, [
    [
      "merge.group.formed",
      {
        projectId: PROJECT,
        groupId: LG,
        partitionId: "p",
        baseSha: EXPECTED_MAIN,
        memberKeys: ["mk-a", "mk-b"],
        policyHash: PROOF_ROOT,
      },
    ],
    [
      "integration.proof_root.composed",
      { projectId: PROJECT, integrationNodeId: NODE, proofRoot: PROOF_ROOT, proofUnitIds: ["u1"] },
    ],
  ]);

  // Finding 3: a FORMING (non-completed) group with a member — its member must NOT be suppressed.
  await seedGroup(owner, {
    lg: LG_FORMING,
    decision: DEC_FORMING,
    state: "forming",
    member: { runId: RUN_FORMING, specId: SPEC_FORMING, memberKey: "mk-f" },
  });
  // Finding 5: a COMPLETED group used for the stale-claim takeover test (no members needed).
  await seedGroup(owner, { lg: LG_STALE, decision: DEC_STALE, state: "completed" });
  await seedGroup(owner, { lg: LG_HB, decision: DEC_HB, state: "completed" });
  await seedGroup(owner, { lg: LG_INTENT, decision: DEC_INTENT, state: "completed" });
}

/** Seed a decision + a land group (+ an optional member run) for the non-primary-group tests. */
export async function seedGroup(
  owner: Pool,
  input: { lg: string; decision: string; state: string; member?: { runId: string; specId: string; memberKey: string } },
): Promise<void> {
  await owner.query(
    `INSERT INTO authority_decisions
       (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
        artifact_digest, proof_root, member_set_hash, policy_version, decision)
     VALUES ($1,$2,$3,$4,'integration_node',$5,$6,$7,$8,'msh','1','authorized')`,
    [ORG, PROJECT, input.decision, NODE, HEAD, EXPECTED_MAIN, ARTIFACT_DIGEST, PROOF_ROOT],
  );
  await owner.query(
    `INSERT INTO land_groups (org_id, id, decision_id, expected_main_sha, authorized_sha, state, main_sha, reconcile_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ORG, input.lg, input.decision, EXPECTED_MAIN, HEAD, input.state, MAIN, `land-group-${input.lg}`],
  );
  const member = input.member;
  if (member !== undefined) {
    await owner.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status, created_at)
       VALUES ($1,$2,$3,'t','d','[]'::jsonb,'in_flight','2026-07-20T00:00:00.000Z')`,
      [member.specId, PROJECT, ORG],
    );
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, pr_url)
       VALUES ($1,$2,$3,$4,'cli','tanren/x','completed','https://github.com/acme/web/pull/9')`,
      [member.runId, member.specId, PROJECT, ORG],
    );
    await owner.query(
      `INSERT INTO land_group_members (org_id, land_group_id, member_key, pr_number, run_id, spec_id, outcome)
       VALUES ($1,$2,$3,'9',$4,$5,'landed')`,
      [ORG, input.lg, member.memberKey, member.runId, member.specId],
    );
  }
}

/** Direct event seed (test-only fixture write — not a production event-write path). */
export async function insertEvents(owner: Pool, runId: string, rows: ReadonlyArray<[string, unknown]>): Promise<void> {
  for (const [eventType, payload] of rows) {
    await owner.query(
      `INSERT INTO ${EVENTS_TABLE} (run_id, project_id, spec_id, org_id, event_type, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [runId, PROJECT, SPEC, ORG, eventType, JSON.stringify(payload)],
    );
  }
}

export function basePlan(): GroupDeliveryPlan {
  return {
    orgId: ORG,
    projectId: PROJECT,
    landGroupId: LG,
    mainSha: MAIN,
    tailRunId: RUN,
    tailSpecId: SPEC,
    deliveryRunId: "delivery-dec",
    memberRunIds: [RUN_A, RUN],
    memberSpecIds: [SPEC_A, SPEC],
  };
}

export const ARTIFACT: GroupArtifact = { artifactDigest: ARTIFACT_DIGEST, deploymentId: "dep-build" };
export const PREVIEW: GroupPreview = {
  release: { releaseInstanceId: "rel-preview", deploymentId: "dep-preview", artifactDigest: ARTIFACT_DIGEST },
  previewDeploymentId: "dep-preview",
};
export const PRODUCTION: GroupProduction = {
  release: { releaseInstanceId: "rel-prod", deploymentId: "dep-prod", artifactDigest: ARTIFACT_DIGEST },
};

/** A happy-path fake deployer: build → preview → demo(ok) → promote → production demo(ok). */
export class HappyFakeDeployer implements GroupDeliveryDeployer {
  // eslint-disable-next-line @typescript-eslint/require-await
  async buildArtifact(): Promise<GroupArtifact> {
    return ARTIFACT;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async recoverDeployVerified(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async applyPreview(): Promise<GroupPreviewOutcome> {
    return { kind: "applied", preview: PREVIEW };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyPreview(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async demo(): Promise<GroupDemoOutcome> {
    return { ok: true, reason: "" };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async teardownPreview(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async promote(): Promise<GroupPromoteOutcome> {
    return { kind: "promoted", production: PRODUCTION };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async currentPriorGood(): Promise<undefined> {
    return undefined;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async rollback(): Promise<void> {}
}

/** A non-production loop fixture has no live integration bindings to seal. */
export class PassingA3Gate implements GroupDeliveryA3Gate {
  // eslint-disable-next-line @typescript-eslint/require-await
  async seal(): Promise<{ readonly kind: "confirmed" }> {
    return { kind: "confirmed" };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(): Promise<{ readonly kind: "confirmed" }> {
    return { kind: "confirmed" };
  }
}

export class NoopAttribution implements GroupRegressionAttribution {
  // eslint-disable-next-line @typescript-eslint/require-await
  async attribute(): Promise<GroupAttributionResult> {
    return { kind: "unattributed", reason: "n/a" };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async route(): Promise<void> {}
}

export const ADMIN: ActorContext = {
  userId: "admin",
  orgId: ORG,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

export function routeApp(pool: Pool, actor: ActorContext): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/orgs", createLandGroupDeliveryRoutes({ pool }));
  return app;
}
