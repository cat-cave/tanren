// rv-6 A2 END-TO-END proof (real Postgres + real HTTP). It drives the prod route
// `POST /internal/acceptance-runs/execute-behaviors` with NO injected drivers or
// resolver — the DEFAULT real HttpAcceptanceSurfaceDriver + real
// PgReleaseInstanceBaseUrlResolver + real PgAcceptancePlanLoader — as the
// restricted tanren_app role. It proves the full seam: stored acceptance spec →
// compiled plan → the run's SPECIFIC release URL (bound by integrationNodeId, not
// last-probeable-wins) → a REAL HTTP probe → a real verdict. A correct product
// passes; a broken expectation fails_product; NEITHER is fabricated.
import { migrate } from "@tanren/db";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import { AllowAllPeerVerifier } from "../src/engine/contracts/index.js";
import { createInternalAcceptanceRunRoutes } from "../src/routes/internal/acceptanceRuns.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_exec_behaviors_rv6";
const PROJECT = "project_exec_behaviors_rv6";
const NODE_ID = "inode_exec_behaviors_rv6";
const ENV_ID = "venv_exec_behaviors_rv6";
const PERSONA_REVISION = "pr_exec_behaviors_rv6";
const PASS_BR = "br_exec_behaviors_pass_rv6";
const FAIL_BR = "br_exec_behaviors_fail_rv6";
const D = `sha256:${"e".repeat(64)}` as Digest;
const CAS = `sha256:${"a".repeat(64)}` as Digest;

const PASS_ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [
    { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
    { assertionId: "a2", subject: "p1.body.count", comparisonOperator: "greater_than", expected: 1 },
  ],
};
const FAIL_ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  // The product genuinely returns count=3; expecting 999 must FAIL on the REAL value.
  assertions: [{ assertionId: "a1", subject: "p1.body.count", comparisonOperator: "equals", expected: 999 }],
};

function databaseName(): string {
  return `tanren_exec_behaviors_rv6_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-rv6')`,
    [NODE_ID, PROJECT, ORG, D],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA_REVISION, ORG, PROJECT, D],
  );
  for (const [id, acceptance, num] of [
    [PASS_BR, PASS_ACCEPTANCE, 1],
    [FAIL_BR, FAIL_ACCEPTANCE, 2],
  ] as const) {
    await owner.query(
      `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
       VALUES ($1, $2, $3, $4, $5, $6, 'behavior', 'g', 'w', 't', $7, $8::jsonb)`,
      [id, ORG, PROJECT, id, PERSONA_REVISION, num, D, JSON.stringify(acceptance)],
    );
  }
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG, ENV_ID, PROJECT, NODE_ID, CAS, D],
  );
  // THIS run's release, bound to NODE_ID, pointing at the live test server.
  await owner.query(
    `INSERT INTO release_instances (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'fly', 'app_exec', 'production', 'dep_run', 'refs/heads/main', $4, $5, $6, 'live')`,
    [ORG, "ri_run_rv6", PROJECT, CAS, NODE_ID, serverUrl],
  );
  // A STALE release for a DIFFERENT integration node, inserted LAST (newest) with a
  // dead URL: a last-probeable-wins resolver would pick it and fail. The node-bound
  // resolver must instead pick THIS run's release above.
  await owner.query(
    `INSERT INTO release_instances (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'fly', 'app_exec', 'production', 'dep_stale', 'refs/heads/main', $4, 'inode_stale_rv6', 'http://127.0.0.1:1', 'live')`,
    [ORG, "ri_stale_rv6", PROJECT, CAS],
  );
}

function body(behaviorRevisionIds: readonly string[]) {
  return {
    orgId: ORG,
    projectId: PROJECT,
    integrationNodeId: NODE_ID,
    environmentId: ENV_ID,
    preparedHeadSha: "abcdef",
    jjTreeId: "tree_1",
    artifactDigest: CAS,
    deploymentFingerprint: D,
    behaviorRevisionIds,
  };
}

describeDb("rv-6 A2 execute-behaviors — real Pg resolver + real HTTP, end-to-end", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let server: Server;
  let routes: ReturnType<typeof createInternalAcceptanceRunRoutes>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", count: 3 }));
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
    // The DEFAULT construction: real HTTP driver + real Pg resolver + real loader.
    routes = createInternalAcceptanceRunRoutes({ pool: app, verifier: new AllowAllPeerVerifier() });
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

  async function execute(behaviorRevisionIds: readonly string[]) {
    const response = await routes.request(
      "/internal/acceptance-runs/execute-behaviors",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body(behaviorRevisionIds)),
      },
      { incoming: { socket: {} } },
    );
    return response;
  }

  it("DECISIVE: a correct product passes through the whole real seam", async () => {
    const response = await execute([PASS_BR]);
    expect(response.status).toBe(201);
    const parsed = (await response.json()) as {
      result: { passedVerdictCount: number; behaviors: { outcome: string }[] };
    };
    expect(parsed.result.behaviors[0]?.outcome).toBe("passed");
    expect(parsed.result.passedVerdictCount).toBe(1);
  });

  it("DECISIVE: a broken expectation fails on the REAL observed value — failed_product, never passed", async () => {
    const response = await execute([FAIL_BR]);
    expect(response.status).toBe(201);
    const parsed = (await response.json()) as {
      result: { passedVerdictCount: number; behaviors: { outcome: string }[] };
    };
    expect(parsed.result.behaviors[0]?.outcome).toBe("failed_product");
    expect(parsed.result.passedVerdictCount).toBe(0);
  });

  it("a malformed / unknown behavior revision fails loud (422), never a fabricated plan", async () => {
    const response = await execute(["br_does_not_exist"]);
    expect(response.status).toBe(422);
    const parsed = (await response.json()) as { error: string };
    expect(parsed.error).toBe("acceptance_plan_load_failed");
  });
});
