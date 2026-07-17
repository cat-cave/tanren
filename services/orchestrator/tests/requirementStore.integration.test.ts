/**
 * in-5: real-Postgres persistence proof for the requirement compiler + store.
 * Opt-in (pg-gated): TANREN_RLS_DB_TEST=1 with a reachable DATABASE_URL. Runs on
 * the NOBYPASSRLS `tanren_app` role so RLS is genuinely enforced.
 *
 * Proves, against migration 0043:
 *  - a messaging G/W/T compiles + persists EXACTLY ONE requirement row + ONE
 *    linked behavior row, and emits integration.requirement.derived once;
 *  - recompiling identical inputs is idempotent (no second row / event);
 *  - a changed document for the same source supersedes the prior row and emits
 *    integration.requirement.superseded;
 *  - the NEGATIVE CONTROL (ambiguous behavior) throws + writes NO row.
 */
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileIntegrationRequirement } from "../src/engine/forge/interview/compileIntegrationRequirement.js";
import {
  AmbiguousIntegrationRequirementError,
} from "../src/engine/forge/interview/compileIntegrationRequirement.js";
import { maybePersistIntegrationRequirement, RequirementStore } from "../src/engine/integrations/requirementStore.js";
import type { CaptureBehavior } from "../src/engine/forge/interview/types.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_in5_requirements";
const PROJECT = "project_in5_requirements";
const BEHAVIOR_REVISION = "brev_in5_celebrate";
const PERSONA_REVISION = "prev_in5_operator";
const DIGEST = `sha256:${"a".repeat(64)}`;

/* eslint-disable unicorn/no-thenable */
const slackCelebrate: CaptureBehavior = {
  persona: "operator",
  title: "celebrate 100 clicks",
  given: "a short link has 99 clicks",
  when: "the 100th click is recorded",
  then: "a celebratory message is posted to our Slack channel",
};
const ambiguousNotify: CaptureBehavior = {
  persona: "operator",
  title: "notify the team",
  given: "",
  when: "an important event occurs",
  then: "the team is notified somehow",
};
/* eslint-enable unicorn/no-thenable */

function dbName(): string {
  return `tanren_in5_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function seed(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/repo.git', $2)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'operator', 'project', 1, 'operator', 'operator', $4)`,
    [PERSONA_REVISION, ORG, PROJECT, DIGEST],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest)
     VALUES ($1, $2, $3, 'behavior_operator_celebrate', $4, 1, 'celebrate 100 clicks', 'g', 'w', 't', $5)`,
    [BEHAVIOR_REVISION, ORG, PROJECT, PERSONA_REVISION, DIGEST],
  );
}

async function requirementEventTypes(runtime: Pool): Promise<string[]> {
  return runWithOrgScope(runtime, ORG, async (client) => {
    const result = await client.query(
      `SELECT event_type FROM events
       WHERE org_id = $1 AND project_id = $2 AND event_type LIKE 'integration.requirement.%'
       ORDER BY id`,
      [ORG, PROJECT],
    );
    return (result.rows as ReadonlyArray<{ event_type: string }>).map((r) => r.event_type);
  });
}

describeDb("in-5 requirement store — real Postgres persistence + supersede + events", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });
    await seed(ownerPool);
  });

  afterAll(async () => {
    await ownerPool?.end();
    await runtimePool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await adminPool.end();
  });

  it("persists exactly one requirement + one behavior link, emits derived once", async () => {
    const compiled = compileIntegrationRequirement(slackCelebrate, null);
    expect(compiled.kind).toBe("requirement");
    if (compiled.kind !== "requirement") return;

    const first = await runWithOrgScope(runtimePool, ORG, (client) =>
      maybePersistIntegrationRequirement(client, {
        orgId: ORG,
        projectId: PROJECT,
        behavior: slackCelebrate,
        designContract: null,
        behaviorRevisionId: BEHAVIOR_REVISION,
      }),
    );
    expect(first?.created).toBe(true);
    expect(first?.desiredStateHash).toBe(compiled.desiredStateHash);

    const rows = await runWithOrgScope(runtimePool, ORG, (client) =>
      RequirementStore.listForProject(client, ORG, PROJECT),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capability).toBe("messaging.send");
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.sourceKind).toBe("behavior_revision");
    expect(rows[0]?.sourceRevisionId).toBe(BEHAVIOR_REVISION);
    expect(rows[0]?.sourceDigest).toBe(compiled.desiredStateHash);
    expect(rows[0]?.behaviors).toEqual([{ behaviorRevisionId: BEHAVIOR_REVISION, relationRole: "requires" }]);

    expect(await requirementEventTypes(runtimePool)).toEqual(["integration.requirement.derived"]);
  });

  it("is idempotent — recompiling the same behavior writes no second row or event", async () => {
    const second = await runWithOrgScope(runtimePool, ORG, (client) =>
      maybePersistIntegrationRequirement(client, {
        orgId: ORG,
        projectId: PROJECT,
        behavior: slackCelebrate,
        designContract: null,
        behaviorRevisionId: BEHAVIOR_REVISION,
      }),
    );
    expect(second?.created).toBe(false);

    const rows = await runWithOrgScope(runtimePool, ORG, (client) =>
      RequirementStore.listForProject(client, ORG, PROJECT),
    );
    expect(rows).toHaveLength(1);
    // Still exactly one derived event, no supersede.
    expect(await requirementEventTypes(runtimePool)).toEqual(["integration.requirement.derived"]);
  });

  it("supersedes the prior row when the document changes for the same source", async () => {
    // A different compiled document (discord instead of slack) under the SAME
    // source revision ⇒ the prior active row is superseded.
    const changed = compileIntegrationRequirement(
      /* eslint-disable unicorn/no-thenable */
      {
        persona: "operator",
        title: "celebrate 100 clicks",
        given: "a short link has 99 clicks",
        when: "the 100th click is recorded",
        then: "a celebratory message is posted to our Discord channel",
      },
      /* eslint-enable unicorn/no-thenable */
      null,
    );
    expect(changed.kind).toBe("requirement");
    if (changed.kind !== "requirement") return;

    const result = await runWithOrgScope(runtimePool, ORG, (client) =>
      RequirementStore.persistDerived(client, {
        orgId: ORG,
        projectId: PROJECT,
        requirement: changed.requirement,
        desiredStateHash: changed.desiredStateHash,
        sourceKind: "behavior_revision",
        sourceRevisionId: BEHAVIOR_REVISION,
        behaviorLinks: [{ behaviorRevisionId: BEHAVIOR_REVISION, relationRole: "requires" }],
      }),
    );
    expect(result.created).toBe(true);
    expect(result.supersededRequirementIds).toHaveLength(1);

    const rows = await runWithOrgScope(runtimePool, ORG, (client) =>
      RequirementStore.listForProject(client, ORG, PROJECT),
    );
    const active = rows.filter((r) => r.status === "active");
    const superseded = rows.filter((r) => r.status === "superseded");
    expect(active).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    expect(active[0]?.sourceDigest).toBe(changed.desiredStateHash);
    expect(superseded[0]?.supersededBy).toBe(active[0]?.requirementId);

    const events = await requirementEventTypes(runtimePool);
    expect(events).toContain("integration.requirement.superseded");
    // The changed document also emits a fresh derived.
    expect(events.filter((e) => e === "integration.requirement.derived")).toHaveLength(2);
  });

  it("NEGATIVE CONTROL — an ambiguous behavior throws and writes no row", async () => {
    const before = await runWithOrgScope(runtimePool, ORG, (client) =>
      RequirementStore.listForProject(client, ORG, PROJECT),
    );

    await expect(
      runWithOrgScope(runtimePool, ORG, (client) =>
        maybePersistIntegrationRequirement(client, {
          orgId: ORG,
          projectId: PROJECT,
          behavior: ambiguousNotify,
          designContract: null,
          behaviorRevisionId: BEHAVIOR_REVISION,
        }),
      ),
    ).rejects.toBeInstanceOf(AmbiguousIntegrationRequirementError);

    const after = await runWithOrgScope(runtimePool, ORG, (client) =>
      RequirementStore.listForProject(client, ORG, PROJECT),
    );
    expect(after).toHaveLength(before.length);
  });
});
