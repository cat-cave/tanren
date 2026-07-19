// cspell:ignore verenv
// rv-17 END-TO-END proof (real Postgres, restricted tanren_app role) that flake classification +
// quarantine governance are REAL, not cosplay. It proves:
//   1. The decisive writes run as non-superuser, non-bypassrls tanren_app.
//   2. Two CONFLICTING recorded verdicts (same behavior + context + artifact: one passed, one
//      failed_product) classify FLAKY from the store, citing both verdict ids as evidence.
//   3. A justified quarantine transition persists + `readActiveQuarantinedBehaviors` surfaces it;
//      an explicit `release` transition removes it (append-only governance, latest-wins).
//   4. ANTI-LAUNDERING DB CHECK: a `quarantine` row can NEVER carry a non-'excluded_from_green'
//      gate_effect NOR a non-'flaky' classification — both are rejected by the 0084 CHECK.
//   5. Append-only: UPDATE and DELETE on a quarantine row are rejected by the immutable trigger.
//   6. Cross-org reads see ZERO rows (RLS deny-by-default).
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBehaviorQuarantineStore } from "../src/engine/repositories/behaviorQuarantines.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_bq_rls";
const OTHER_ORG = "org_bq_rls_other";
const PROJECT = "project_bq_rls";
const PERSONA = "pr_bq_rls";
const BEHAVIOR = "br_bq_rls";
const NODE = "inode_bq_rls";
const DIGEST = `sha256:${"a".repeat(64)}`;
const CTX = `sha256:${"d".repeat(64)}`;

function databaseName(): string {
  return `tanren_bq_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA, ORG, PROJECT, DIGEST],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
     VALUES ($1, $2, $3, $1, $4, 1, 'behavior', 'g', 'w', 't', $5, '{}'::jsonb)`,
    [BEHAVIOR, ORG, PROJECT, PERSONA, DIGEST],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-bq')`,
    [NODE, PROJECT, ORG, DIGEST],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, DIGEST, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, 'verenv_bq', $2, $3, $4, 'production', 'bq-fp', 'bq-lease', 'ready')`,
    [ORG, PROJECT, NODE, DIGEST],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, integration_node_id, environment_id, prepared_head_sha, jj_tree_id,
        plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, 'vrun_bq', $2, 'post_merge_production', $3, 'verenv_bq', $4, $4, $5, $6, $7, 'completed', '{}'::jsonb)`,
    [ORG, PROJECT, NODE, `${DIGEST}-sha`, CTX, CTX, DIGEST],
  );
  // Two CONFLICTING verdicts for the SAME behavior + context + artifact: one passed, one failed_product.
  for (const [id, outcome] of [
    ["verdict_bq_pass", "passed"],
    ["verdict_bq_fail", "failed_product"],
  ] as const) {
    await owner.query(
      `WITH verdict AS (
         INSERT INTO behavior_verdicts
           (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
            required_assertion_count, executed_assertion_count, outcome, attempt_count,
            flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
         VALUES ($1, $2, $3, 'vrun_bq', $4, 'ex', 'mx', 1, 1, $5, 1, 'stable', 'blocking', $6, $7)
         RETURNING org_id, id
       ), attempt AS (
         INSERT INTO behavior_verdict_attempts (org_id, verdict_id, attempt_ordinal, outcome)
         SELECT org_id, id, 1, $5 FROM verdict
       )
       INSERT INTO behavior_verdict_assertions (org_id, verdict_id, assertion_id, executed, passed)
       SELECT org_id, id, 'assertion_seed', true, $5 = 'passed' FROM verdict`,
      [ORG, id, PROJECT, BEHAVIOR, outcome, DIGEST, CTX],
    );
  }
}

describeDb("rv-17 flake classification + quarantine governance — real Postgres, tanren_app role", () => {
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
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("REAL: two conflicting recorded verdicts (same artifact + purpose) classify FLAKY, citing both verdict ids", async () => {
    const result = await new PgBehaviorQuarantineStore(app).classifyBehaviorFlake({
      orgId: ORG,
      projectId: PROJECT,
      behaviorRevisionId: BEHAVIOR,
      artifactDigest: DIGEST,
      purpose: "post_merge_production",
    });
    expect(result.classification).toBe("flaky");
    expect(result.evidence.map((e) => e.verdictId).sort()).toEqual(["verdict_bq_fail", "verdict_bq_pass"]);
  });

  it("GOVERNANCE: a justified quarantine persists + is surfaced; an explicit release removes it (latest-wins)", async () => {
    const store = new PgBehaviorQuarantineStore(app);
    await store.recordTransition({
      orgId: ORG,
      projectId: PROJECT,
      behaviorRevisionId: BEHAVIOR,
      transition: "quarantine",
      classification: "flaky",
      reason: "observed pass/fail conflict",
      actor: "operator@example.com",
      evidence: [
        { verdictId: "verdict_bq_pass", outcome: "passed" },
        { verdictId: "verdict_bq_fail", outcome: "failed_product" },
      ],
      contextHash: CTX,
      epoch: DIGEST,
    });
    let active = await store.readActiveQuarantinedBehaviors({ orgId: ORG, projectId: PROJECT });
    expect(active.has(BEHAVIOR)).toBe(true);
    expect(await store.isQuarantined({ orgId: ORG, projectId: PROJECT }, BEHAVIOR)).toBe(true);

    await store.recordTransition({
      orgId: ORG,
      projectId: PROJECT,
      behaviorRevisionId: BEHAVIOR,
      transition: "release",
      classification: "stable",
      reason: "root cause fixed",
      actor: "operator@example.com",
      evidence: [],
      contextHash: CTX,
      epoch: DIGEST,
    });
    active = await store.readActiveQuarantinedBehaviors({ orgId: ORG, projectId: PROJECT });
    expect(active.has(BEHAVIOR)).toBe(false);
    expect(await store.isQuarantined({ orgId: ORG, projectId: PROJECT }, BEHAVIOR)).toBe(false);
  });

  it("ANTI-LAUNDERING CHECK: a quarantine row cannot carry a non-'excluded_from_green' gate_effect", async () => {
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query(
          `INSERT INTO behavior_flake_quarantines
             (org_id, project_id, id, behavior_revision_id, transition, gate_effect, classification, reason, actor, context_hash, epoch)
           VALUES ($1, $2, 'bq_bad_effect', $3, 'quarantine', 'restored', 'flaky', 'r', 'a', $4, $5)`,
          [ORG, PROJECT, BEHAVIOR, CTX, DIGEST],
        ),
      ),
    ).rejects.toThrow(/behavior_flake_quarantines_transition_shape_check/u);
  });

  it("ANTI-LAUNDERING CHECK: a quarantine row cannot be justified by a non-'flaky' classification", async () => {
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query(
          `INSERT INTO behavior_flake_quarantines
             (org_id, project_id, id, behavior_revision_id, transition, gate_effect, classification, reason, actor, context_hash, epoch)
           VALUES ($1, $2, 'bq_bad_class', $3, 'quarantine', 'excluded_from_green', 'stable', 'r', 'a', $4, $5)`,
          [ORG, PROJECT, BEHAVIOR, CTX, DIGEST],
        ),
      ),
    ).rejects.toThrow(/behavior_flake_quarantines_transition_shape_check/u);
  });

  it("APPEND-ONLY: UPDATE and DELETE on a quarantine row are rejected by the immutable trigger", async () => {
    await runWithOrgScope(app, ORG, (client) =>
      client.query(
        `INSERT INTO behavior_flake_quarantines
           (org_id, project_id, id, behavior_revision_id, transition, gate_effect, classification, reason, actor, context_hash, epoch)
         VALUES ($1, $2, 'bq_immutable', $3, 'quarantine', 'excluded_from_green', 'flaky', 'r', 'a', $4, $5)`,
        [ORG, PROJECT, BEHAVIOR, CTX, DIGEST],
      ),
    );
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query(`UPDATE behavior_flake_quarantines SET reason = 'x' WHERE org_id = $1 AND id = 'bq_immutable'`, [
          ORG,
        ]),
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query(`DELETE FROM behavior_flake_quarantines WHERE org_id = $1 AND id = 'bq_immutable'`, [ORG]),
      ),
    ).rejects.toThrow(/immutable/u);
  });

  it("org isolation: another org sees ZERO of this org's quarantines (RLS denies cross-org reads)", async () => {
    const foreign = await runWithOrgScope(app, OTHER_ORG, async (client) => {
      const rows = await client.query<{ n: string }>("SELECT count(*) AS n FROM behavior_flake_quarantines", []);
      return Number(rows.rows[0]?.n ?? "0");
    });
    expect(foreign).toBe(0);
  });
});
