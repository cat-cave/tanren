// rv-3 RLS proof — the verification-fragment registry + F2 authoring, driven through
// the real `PgAcceptancePlanLoader` as the restricted non-superuser tanren_app role.
// A behavior whose acceptance spec CITES a verification capability, loaded with the
// F2 authoring seam configured, authors the missing fragment (writer→validate
// convergent), atomically REGISTERS it in `verification_fragments` +
// `verification_fragment_versions` (conformance passed), and BINDS it into the plan
// (`behavior_verification_plans` + `verification_plan_fragments`). Because RLS denies
// cross-org rows, a resolve under another org's scope sees ZERO and the whole load
// under another org fails loud (never a fabricated plan or leaked fragment).

import { migrate } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthoringAuthorer, AuthoringEvents } from "../src/engine/contracts/authoringKernel.js";
import type { Digest } from "../src/engine/contracts/cas.js";
import { PgVerificationFragmentStore } from "../src/engine/repositories/verificationFragmentStore.js";
import {
  BehaviorRevisionNotFoundError,
  PgAcceptancePlanLoader,
  VERIFICATION_FRAGMENT_CONTRACT_VERSION,
  createVerificationFragmentAuthoringEventFactory,
  type ValidatedVerificationFragment,
  type VerificationFragmentAuthoringEvent,
  type VerificationFragmentDraftV1,
  type VerificationFragmentSpecV1,
} from "../src/engine/verification/acceptance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_vf_rv3";
const OTHER_ORG = "org_vf_rv3_other";
const PROJECT = "project_vf_rv3";
const BEHAVIOR_REVISION = "br_vf_rv3";
const PERSONA_REVISION = "pr_vf_rv3";
const D = `sha256:${"c".repeat(64)}` as Digest;

const ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
  capabilities: [
    { stepKind: "fixture", stepId: "f1", capabilityKey: "seed_user", fragmentKind: "fixture", surface: "api" },
  ],
};

const noopEvents: AuthoringEvents<
  VerificationFragmentSpecV1,
  VerificationFragmentDraftV1,
  ValidatedVerificationFragment,
  VerificationFragmentAuthoringEvent
> = { factory: createVerificationFragmentAuthoringEventFactory(), sink: { async emit(): Promise<void> {} } };

const fixtureAuthorer: AuthoringAuthorer<VerificationFragmentSpecV1, VerificationFragmentDraftV1> = {
  async author({ spec }): Promise<VerificationFragmentDraftV1> {
    return {
      capabilityKey: spec.capabilityKey,
      fragmentKind: spec.fragmentKind,
      surface: spec.surface,
      version: "1.0.0",
      contractVersion: VERIFICATION_FRAGMENT_CONTRACT_VERSION,
      entrypoint: "seedUser",
      source: "export function seedUser() { return { ok: true }; }",
    };
  },
};

function databaseName(): string {
  return `tanren_vf_rv3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    [PERSONA_REVISION, ORG, PROJECT, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
     VALUES ($1, $2, $3, 'behavior', $4, 1, 'behavior', 'g', 'w', 't', $5, $6::jsonb)`,
    [BEHAVIOR_REVISION, ORG, PROJECT, PERSONA_REVISION, D, JSON.stringify(ACCEPTANCE)],
  );
}

describeDb("rv-3 verification-fragment registry + F2 authoring — real Postgres, tenant-scoped", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let loader: PgAcceptancePlanLoader;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
    loader = new PgAcceptancePlanLoader(app, {
      authoring: {
        deps: { authorer: fixtureAuthorer, store: new PgVerificationFragmentStore(app), events: noopEvents },
      },
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

  it("runs as the non-superuser tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("F2-authors the cited capability, registers + versions it, and binds it into the plan", async () => {
    const plans = await loader.loadPlans({ orgId: ORG, behaviorRevisionIds: [BEHAVIOR_REVISION] });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.capabilityFragments).toHaveLength(1);
    expect(plans[0]?.capabilityFragments?.[0]?.capabilityFragmentRef.capabilityKey).toBe("seed_user");

    const fragments = await owner.query(
      "SELECT capability_key, fragment_kind FROM verification_fragments WHERE org_id = $1 AND project_id = $2",
      [ORG, PROJECT],
    );
    expect(fragments.rows).toEqual([{ capability_key: "seed_user", fragment_kind: "fixture" }]);

    const versions = await owner.query<{ conformance_status: string; contract_version: string }>(
      "SELECT conformance_status, contract_version FROM verification_fragment_versions WHERE org_id = $1",
      [ORG],
    );
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]?.conformance_status).toBe("passed");
    expect(versions.rows[0]?.contract_version).toBe(VERIFICATION_FRAGMENT_CONTRACT_VERSION);

    const planRows = await owner.query("SELECT status FROM behavior_verification_plans WHERE org_id = $1", [ORG]);
    expect(planRows.rows).toEqual([{ status: "compiled" }]);

    const planFragments = await owner.query("SELECT step_id FROM verification_plan_fragments WHERE org_id = $1", [ORG]);
    expect(planFragments.rows).toEqual([{ step_id: "f1" }]);
  });

  it("is idempotent: a re-load reuses the registered version — no duplicate rows", async () => {
    await loader.loadPlans({ orgId: ORG, behaviorRevisionIds: [BEHAVIOR_REVISION] });
    const versions = await owner.query("SELECT id FROM verification_fragment_versions WHERE org_id = $1", [ORG]);
    expect(versions.rows).toHaveLength(1);
  });

  it("org isolation: a resolve under another org's scope sees ZERO fragment rows", async () => {
    const store = new PgVerificationFragmentStore(app);
    const mine = await store.resolveByCapability({
      orgId: ORG,
      projectId: PROJECT,
      capabilityKey: "seed_user",
      fragmentKind: "fixture",
    });
    const theirs = await store.resolveByCapability({
      orgId: OTHER_ORG,
      projectId: PROJECT,
      capabilityKey: "seed_user",
      fragmentKind: "fixture",
    });
    expect(mine).toBeDefined();
    expect(theirs).toBeUndefined();
  });

  it("org isolation: loading the behavior under another org fails loud (zero rows)", async () => {
    await expect(
      loader.loadPlans({ orgId: OTHER_ORG, behaviorRevisionIds: [BEHAVIOR_REVISION] }),
    ).rejects.toBeInstanceOf(BehaviorRevisionNotFoundError);
  });
});
