import { createDbPool, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activatePolicyRevision,
  compilePolicyRevision,
  createPolicyRevision,
  getPolicyRevision,
  listPolicyRevisions,
} from "./policyRevisionStore.js";
import type { PolicyAst } from "./policyAst.js";

const enabled = process.env["TANREN_GV7_PG_TEST"] === "1";
const orgId = process.env["TANREN_GV7_TEST_ORG_ID"] ?? "org_gv7_smoke";
const projectId = process.env["TANREN_GV7_TEST_PROJECT_ID"] ?? "project_gv7_smoke";
const appPassword = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
// The owner pool seeds fixtures (organizations/projects). RLS is enforced only for a
// NON-superuser role, so every org-scoped assertion runs through the `tanren_app` pool —
// the `tanren` owner is a superuser and would BYPASS row-level security under FORCE.
const ownerPool = enabled ? createDbPool() : undefined;
const appPool = enabled ? appClientPool() : undefined;

function appClientPool(): Pool {
  const url = new URL(process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren");
  url.username = "tanren_app";
  url.password = appPassword;
  return new Pool({ connectionString: url.toString() });
}

const smokePolicy: PolicyAst = {
  apiVersion: "tanren.dev/governance/v2",
  schemaVersion: 1,
  core: { rules: [{ key: "repository.visibility", value: "private" }] },
  org: { rules: [{ key: "review.freshness", value: "exact_head_sha" }] },
  tier: { rules: [{ key: "review.minimum_approvals", value: 1 }] },
  binding: { rules: [] },
};

describe.skipIf(!enabled)("gv-7 PostgreSQL RLS and append-only proof", () => {
  beforeAll(async () => {
    const owner = requirePool(ownerPool);
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [orgId],
    );
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, $1, $2, $3)
       ON CONFLICT (project_id) DO NOTHING`,
      [projectId, `https://example.com/${projectId}.git`, orgId],
    );
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  it("writes in one org scope, hides the row from another org, and emits correlated events", async () => {
    const database = requirePool(appPool);
    const revision = await runWithOrgScope(database, orgId, (client) =>
      createPolicyRevision(client, {
        orgId,
        projectId,
        sourceDocument: smokePolicy,
        createdBy: "gv7-rls-test",
      }),
    );
    const loaded = await runWithOrgScope(database, orgId, (client) =>
      getPolicyRevision(client, orgId, projectId, revision.id),
    );
    expect(loaded.policyHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await runWithOrgScope(database, orgId, (client) => compilePolicyRevision(client, orgId, loaded));
    await runWithOrgScope(database, orgId, (client) => activatePolicyRevision(client, orgId, loaded));
    const activeRevision = (
      await runWithOrgScope(database, orgId, (client) => listPolicyRevisions(client, orgId, projectId))
    ).find((candidate) => candidate.id === revision.id);
    expect(activeRevision).toMatchObject({ id: revision.id, status: "active" });

    const hidden = await runWithOrgScope(database, `${orgId}_other`, (client) =>
      client.query("SELECT id FROM governance_policy_revisions WHERE id = $1", [revision.id]),
    );
    expect(hidden.rows).toHaveLength(0);

    const events = await runWithOrgScope(database, orgId, (client) =>
      client.query<{ event_type: string; revision_id: string }>(
        `SELECT event_type, payload->>'revisionId' AS revision_id
           FROM events
          WHERE project_id = $1 AND payload->>'revisionId' = $2
          ORDER BY id`,
        [projectId, revision.id],
      ),
    );
    expect(events.rows).toEqual([
      { event_type: "governance.policy.created", revision_id: revision.id },
      { event_type: "governance.policy.compiled", revision_id: revision.id },
      { event_type: "governance.policy.activated", revision_id: revision.id },
    ]);

    await expect(
      runWithOrgScope(database, orgId, (client) =>
        client.query("UPDATE governance_policy_revisions SET created_by = 'tampered' WHERE id = $1", [revision.id]),
      ),
    ).rejects.toThrow(/append-only/u);
  });
});

function requirePool(value: Pool | undefined): Pool {
  if (value === undefined) throw new Error("TANREN_GV7_PG_TEST did not enable the PostgreSQL test");
  return value;
}
