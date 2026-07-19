// cspell:ignore verenv
// rv-17 REAL-SEAM proof (real Postgres + real HTTP, restricted tanren_app role) that the LIVE
// post-merge production behavior-verdict lane ACTUATES flake quarantine. Nothing is hand-called:
// `buildPostMergeBehaviorAcceptanceVerifier(app).verify(...)` — the exact production verifier the
// resolution walker AND the operator-retry route drive — records a real post_merge_production
// behavior verdict and then, off the RECORDED verdicts, classifies the behavior and persists a
// `quarantine` transition when the same behavior + artifact + purpose shows a pass↔fail conflict.
//
// This closes the "dormant governance" gap: it proves a PRODUCTION path writes a quarantine row.
//   • A behavior with a PRIOR post_merge_production `failed_product` verdict (same artifact) whose
//     new production verdict is `passed` = a real pass↔fail conflict ⇒ auto-quarantined (flaky).
//   • The quarantine row is the anti-laundering shape: transition='quarantine',
//     gate_effect='excluded_from_green', classification='flaky', actor=the classifier identity.
//   • Cross-org reads see ZERO rows (RLS deny-by-default).
import { migrate, runWithOrgScope } from "@tanren/db";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPostMergeBehaviorAcceptanceVerifier } from "../src/engine/verification/postMergeReproof/behaviorAcceptanceVerdict.js";
import { PgBehaviorQuarantineStore } from "../src/engine/repositories/behaviorQuarantines.js";
import { FLAKE_CLASSIFIER_ACTOR } from "../src/engine/verification/acceptance/flakeQuarantineActuator.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_fq_rls";
const OTHER_ORG = "org_fq_rls_other";
const PROJECT = "project_fq_rls";
const PERSONA = "pr_fq_rls";
const FLAKY_BR = "br_fq_flaky";
const NODE_ID = "inode_fq_live";
const NODE_PRIOR = "inode_fq_prior";
const RELEASE_ID = "ri_fq_live";
const CAS = `sha256:${"a".repeat(64)}`;
const PRIOR_CTX = `sha256:${"c".repeat(64)}`;
const GIT_SHA = "a".repeat(40);

// Passes against the live server (/health → 200), so the NEW production verdict is `passed`.
const FLAKY_ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
};

function databaseName(): string {
  return `tanren_fq_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedTenant(owner: Pool, serverUrl: string): Promise<void> {
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
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA, ORG, PROJECT, CAS],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
     VALUES ($1, $2, $3, $1, $4, 1, 'behavior', 'g', 'w', 't', $5, $6::jsonb)`,
    [FLAKY_BR, ORG, PROJECT, PERSONA, CAS, JSON.stringify(FLAKY_ACCEPTANCE)],
  );
  for (const node of [NODE_ID, NODE_PRIOR]) {
    await owner.query(
      `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
       VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', $5)`,
      [node, PROJECT, ORG, CAS, `member-${node}`],
    );
  }
  await owner.query(
    `INSERT INTO release_instances (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'fly', 'app_fq', 'production', 'dep_fq', $4, $5, $6, $7, 'live')`,
    [ORG, RELEASE_ID, PROJECT, GIT_SHA, CAS, NODE_ID, serverUrl],
  );
  await owner.query(
    `INSERT INTO release_instance_behavior_revisions (org_id, release_instance_id, behavior_revision_id, ordinal)
     VALUES ($1, $2, $3, 0)`,
    [ORG, RELEASE_ID, FLAKY_BR],
  );

  // The PRIOR post_merge_production FAILED verdict for the SAME behavior + artifact, under a
  // DIFFERENT integration node (so the lane's already-recorded guard — keyed on THIS release's node
  // + artifact — does not trip, yet the flake window sees both verdicts at artifact CAS).
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, 'verenv_fq_prior', $2, $3, $4, 'production', 'prior-fp', 'prior-lease', 'ready')`,
    [ORG, PROJECT, NODE_PRIOR, CAS],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, integration_node_id, environment_id, prepared_head_sha, jj_tree_id,
        plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, 'vrun_fq_prior', $2, 'post_merge_production', $3, 'verenv_fq_prior', $4, $4, $5, $6, $7, 'completed', '{}'::jsonb)`,
    [ORG, PROJECT, NODE_PRIOR, GIT_SHA, PRIOR_CTX, PRIOR_CTX, CAS],
  );
  await owner.query(
    `WITH verdict AS (
       INSERT INTO behavior_verdicts
         (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
          required_assertion_count, executed_assertion_count, outcome, attempt_count,
          flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
       VALUES ($1, 'verdict_fq_prior', $2, 'vrun_fq_prior', $3, 'ex', 'mx', 1, 1, 'failed_product', 1,
               'stable', 'blocking', $4, $5)
       RETURNING org_id, id
     ), attempt AS (
       INSERT INTO behavior_verdict_attempts (org_id, verdict_id, attempt_ordinal, outcome)
       SELECT org_id, id, 1, 'failed_product' FROM verdict
     )
     INSERT INTO behavior_verdict_assertions (org_id, verdict_id, assertion_id, executed, passed)
     SELECT org_id, id, 'assertion_seed', true, false FROM verdict`,
    [ORG, PROJECT, FLAKY_BR, CAS, PRIOR_CTX],
  );
}

describeDb("rv-17 LIVE post-merge flake quarantine — verify() actuates a quarantine row", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let server: Server;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner, serverUrl);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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

  it("DECISIVE: the LIVE verify() records a passing production verdict then AUTO-QUARANTINES the flaky behavior", async () => {
    const result = await buildPostMergeBehaviorAcceptanceVerifier(app).verify({
      orgId: ORG,
      projectId: PROJECT,
      releaseInstanceId: RELEASE_ID,
    });
    // The new production verdict passed (200), forming a pass↔fail conflict with the prior failed one.
    expect(result.decision).toBe("recorded");
    expect(result.passed).toBe(1);

    // The LIVE lane persisted a quarantine row — the mechanism is not dormant.
    const row = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{
        transition: string;
        gate_effect: string;
        classification: string;
        actor: string;
        evidence: { verdictId: string; outcome: string }[];
      }>(
        `SELECT transition, gate_effect, classification, actor, evidence
           FROM behavior_flake_quarantines WHERE org_id = $1 AND behavior_revision_id = $2`,
        [ORG, FLAKY_BR],
      );
      return rows.rows[0];
    });
    expect(row).toBeDefined();
    expect(row!.transition).toBe("quarantine");
    expect(row!.gate_effect).toBe("excluded_from_green");
    expect(row!.classification).toBe("flaky");
    expect(row!.actor).toBe(FLAKE_CLASSIFIER_ACTOR);
    // The evidence cites the actual conflicting recorded verdicts (a passed + a failed_product).
    expect(new Set(row!.evidence.map((e) => e.outcome))).toEqual(new Set(["passed", "failed_product"]));

    // The store's read seam (consulted LIVE by rv-16 bisection) now reports the behavior quarantined.
    const quarantined = await new PgBehaviorQuarantineStore(app).isQuarantined(
      { orgId: ORG, projectId: PROJECT },
      FLAKY_BR,
    );
    expect(quarantined).toBe(true);
  });

  it("org isolation: another org sees ZERO of this org's quarantines (RLS denies cross-org reads)", async () => {
    const foreign = await runWithOrgScope(app, OTHER_ORG, async (client) => {
      const rows = await client.query<{ n: string }>("SELECT count(*) AS n FROM behavior_flake_quarantines", []);
      return Number(rows.rows[0]?.n ?? "0");
    });
    expect(foreign).toBe(0);
  });
});
