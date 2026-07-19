// cspell:ignore verenv
// rv-16b END-TO-END proof (real Postgres + real HTTP) that the behavior-aware regression
// bisector, run as the restricted tanren_app role, localizes WHICH deployed candidate release
// introduced a regressed post-merge behavior by RE-PROVING the failing behavior against each
// candidate's real deployment URL (the rv-11 orchestrator + rv-6 driver), and PERSISTS the
// sealed result + probe trail into behavior_regression_bisections (0083). It proves:
//   1. The decisive writes run as non-superuser, non-bypassrls tanren_app.
//   2. A real healthy→regressed flip LOCALIZES the culprit release; the persisted row is
//      status='localized' with the culprit set + a real probe trail (200→passed, 500→failed_product).
//   3. The 0083 CHECK holds (a localized row carries a culprit; the trail is the real outcomes).
//   4. Cross-org reads see ZERO rows (RLS deny-by-default).
import { migrate, runWithOrgScope } from "@tanren/db";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRegressionBisector } from "../src/engine/verification/postMergeReproof/regressionBisectionBuild.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_rb_rls";
const OTHER_ORG = "org_rb_rls_other";
const PROJECT = "project_rb_rls";
const PERSONA = "pr_rb_rls";
const BEHAVIOR = "br_rb_rls";
const CTX = `sha256:${"d".repeat(64)}`;
// Distinct (integration node, artifact digest, url) per release so the verdict→release mapping
// is unambiguous and each candidate is re-proven against its OWN deployment.
const RELEASES = [
  { key: "base", node: "inode_rb_base", digest: `sha256:${"a".repeat(64)}`, path: "/base", state: "healthy" },
  { key: "c1", node: "inode_rb_c1", digest: `sha256:${"b".repeat(64)}`, path: "/c1", state: "healthy" },
  { key: "c2", node: "inode_rb_c2", digest: `sha256:${"c".repeat(64)}`, path: "/c2", state: "regressed" },
  { key: "c3", node: "inode_rb_c3", digest: `sha256:${"e".repeat(64)}`, path: "/c3", state: "regressed" },
] as const;
// c3 = the live failing release rv-16a recorded regressed.
const FAILING = RELEASES[3];
const FAIL_VERDICT = "verdict_rb_fail";

const ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "health" }],
  assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
};

function databaseName(): string {
  return `tanren_rb_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA, ORG, PROJECT, RELEASES[0].digest],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
     VALUES ($1, $2, $3, $1, $4, 1, 'behavior', 'g', 'w', 't', $5, $6::jsonb)`,
    [BEHAVIOR, ORG, PROJECT, PERSONA, RELEASES[0].digest, JSON.stringify(ACCEPTANCE)],
  );
  let previous: string | null = null;
  for (const release of RELEASES) {
    await owner.query(
      `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
       VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', $5)`,
      [release.node, PROJECT, ORG, release.digest, `member-${release.key}`],
    );
    await owner.query(
      `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
       VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
      [ORG, release.digest, Buffer.from([0])],
    );
    // Each release's live URL routes to its OWN path prefix on the shared test server; the
    // relative probe path "health" resolves under it (e.g. .../c2/health).
    const state = release.key === FAILING.key ? "live" : "superseded";
    await owner.query(
      `INSERT INTO release_instances (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest, integration_node_id, url, previous_release_instance_id, state)
       VALUES ($1, $2, $3, 'fly', 'app_rb', 'production', $4, $5, $6, $7, $8, $9, $10)`,
      [
        ORG,
        `ri_${release.key}`,
        PROJECT,
        `dep_${release.key}`,
        `${release.key}-sha`,
        release.digest,
        release.node,
        `${serverUrl}${release.path}/`,
        previous,
        state,
      ],
    );
    previous = `ri_${release.key}`;
  }

  // The known-good baseline anchor: a REAL passed post_merge_production verdict at the base release
  // (its own node + digest), so the chain reader anchors the bisection window just after it.
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, 'verenv_rb_base', $2, $3, $4, 'production', 'base-fp', 'base-lease', 'ready')`,
    [ORG, PROJECT, RELEASES[0].node, RELEASES[0].digest],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, integration_node_id, environment_id, prepared_head_sha, jj_tree_id,
        plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, 'vrun_rb_base', $2, 'post_merge_production', $3, 'verenv_rb_base', $4, $4, $5, $6, $7, 'completed', '{}'::jsonb)`,
    [ORG, PROJECT, RELEASES[0].node, `${RELEASES[0].key}-sha`, CTX, CTX, RELEASES[0].digest],
  );
  await owner.query(
    `INSERT INTO behavior_verdicts
       (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
        required_assertion_count, executed_assertion_count, outcome, attempt_count,
        flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
     VALUES ($1, 'verdict_rb_base', $2, 'vrun_rb_base', $3, 'ex', 'mx', 1, 1, 'passed', 1,
             'stable', 'blocking', $4, $5)`,
    [ORG, PROJECT, BEHAVIOR, RELEASES[0].digest, CTX],
  );
}

describeDb("rv-16b regression bisection — real Postgres + HTTP, localizes the culprit release", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let server: Server;

  beforeAll(async () => {
    server = createServer((req, res) => {
      // /base/health & /c1/health → 200 (healthy); /c2/health & /c3/health → 500 (regressed).
      const healthy = (req.url ?? "").startsWith("/base/") || (req.url ?? "").startsWith("/c1/");
      res.writeHead(healthy ? 200 : 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: healthy }));
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

  it("DECISIVE: localizes the culprit release via real probes + persists the sealed result", async () => {
    const result = await buildRegressionBisector(app).bisect({
      orgId: ORG,
      projectId: PROJECT,
      behaviorRevisionId: BEHAVIOR,
      failingReleaseInstanceId: `ri_${FAILING.key}`,
      failingVerdictId: FAIL_VERDICT,
    });
    // c1 was the last healthy release, c2 the first regressed → c2 is the culprit.
    expect(result.status).toBe("localized");
    expect(result.culprit?.releaseInstanceId).toBe("ri_c2");

    const row = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{
        status: string;
        culprit_release_instance_id: string | null;
        culprit_integration_node_id: string | null;
        inconclusive_reason: string | null;
        baseline_release_instance_id: string | null;
        candidate_count: number;
        probe_count: number;
        probe_trail: { releaseInstanceId: string; outcome: string; classification: string; role: string }[];
      }>(
        `SELECT status, culprit_release_instance_id, culprit_integration_node_id, inconclusive_reason,
                baseline_release_instance_id, candidate_count, probe_count, probe_trail
           FROM behavior_regression_bisections WHERE org_id = $1 AND failing_verdict_id = $2`,
        [ORG, FAIL_VERDICT],
      );
      return rows.rows[0];
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe("localized");
    expect(row!.culprit_release_instance_id).toBe("ri_c2");
    expect(row!.culprit_integration_node_id).toBe("inode_rb_c2");
    expect(row!.inconclusive_reason).toBeNull();
    expect(row!.baseline_release_instance_id).toBe("ri_base");
    expect(row!.candidate_count).toBe(3);
    // The probe trail is the REAL outcomes: c2 failed_product (500), c1 passed (200).
    const trail = row!.probe_trail;
    expect(trail.find((p) => p.releaseInstanceId === "ri_c2")?.outcome).toBe("failed_product");
    expect(trail.find((p) => p.releaseInstanceId === "ri_c1")?.outcome).toBe("passed");
    expect(trail.find((p) => p.releaseInstanceId === "ri_c3")?.role).toBe("tip");
  });

  it("org isolation: another org sees ZERO of this org's bisections (RLS denies cross-org reads)", async () => {
    const foreign = await runWithOrgScope(app, OTHER_ORG, async (client) => {
      const rows = await client.query<{ n: string }>("SELECT count(*) AS n FROM behavior_regression_bisections", []);
      return Number(rows.rows[0]?.n ?? "0");
    });
    expect(foreign).toBe(0);
  });
});
