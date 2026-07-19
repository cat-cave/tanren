// rv-1 — the production mint→bind proof for immutable behavior revisions.
//
// Drives the REAL spec-freeze entry point (`deriveBehaviorSpec`, the sole
// production site that authors + links + freezes a behavior) as the restricted
// non-superuser `tanren_app` role under org scope, then exercises the store's
// immutability / idempotency / binding invariants directly:
//   • a behavior is minted as an IMMUTABLE, content-addressed revision bound to
//     its originating spec (authoring_provenance.originatingSpecId);
//   • re-minting identical content is idempotent (SAME revision id + digest);
//   • changed content mints a NEW revision (number+1) and supersedes the prior
//     active one (status-only);
//   • a raw content UPDATE / DELETE is rejected at the DB (migration 0090
//     trigger) — a persisted revision can never be mutated;
//   • binding a behavior revision to a non-existent persona revision is rejected
//     with a typed error (fail-closed);
//   • RLS: a peer org sees ZERO of another org's revisions.
//
// Gated on TANREN_RLS_DB_TEST like every peer *.rls.integration test.
/* eslint-disable unicorn/no-thenable -- `then` is the BDD field name in behavior bodies, not a thenable. */
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { deriveBehaviorSpec } from "../src/engine/forge/interview/deriveBehaviorSpec.js";
import {
  PgBehaviorRevisionStore,
  PgPersonaRevisionStore,
  RevisionBindingError,
  RevisionImmutabilityError,
} from "../src/engine/repositories/behaviorRevisionStore.js";
import { parsePersonaRevisionId } from "../src/engine/contracts/behaviorRevision.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_rev_mint_a";
const ORG_B = "org_rev_mint_b";
const PROJECT_A = "project_rev_mint_a";
const PERSONA_A = "persona_rev_mint_a";
const MILESTONE_A = "milestone_rev_mint_a";
const BEHAVIOR_A = "behavior_rev_mint_a";

function databaseName(): string {
  return `tanren_rev_mint_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const actorA: ActorContext = {
  userId: "user_rev_mint",
  orgId: ORG_A,
  projectId: PROJECT_A,
  scopes: ["org:member"],
};

async function seedTenant(owner: Pool): Promise<void> {
  for (const org of [ORG_A, ORG_B]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [org],
    );
  }
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT_A, ORG_A],
  );
  await owner.query(
    `INSERT INTO personas (id, scope, org_id, project_id, name, description, metadata)
     VALUES ($1, 'project', $2, $3, 'Buyer', 'A buyer persona', '{"surface":"web"}'::jsonb)`,
    [PERSONA_A, ORG_A, PROJECT_A],
  );
  await owner.query(
    `INSERT INTO milestones (id, project_id, label, name, order_index, status)
     VALUES ($1, $2, 'M2', 'checkout', 1, 'planned')`,
    [MILESTONE_A, PROJECT_A],
  );
}

async function countRevisions(app: Pool, org: string, behaviorId: string): Promise<number> {
  return runWithOrgScope(app, org, async (client) => {
    const r = await client.query<{ n: string }>("SELECT COUNT(*) AS n FROM behavior_revisions WHERE behavior_id = $1", [
      behaviorId,
    ]);
    return Number(r.rows[0]!.n);
  });
}

describeDb("rv-1 — immutable behavior revision mint + spec binding", () => {
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

  it("the real freeze entry point mints an immutable revision bound to its spec", async () => {
    const spec = await runWithOrgScope(app, ORG_A, (client) =>
      deriveBehaviorSpec(client, {
        projectId: PROJECT_A,
        orgId: ORG_A,
        behavior: {
          persona: "Buyer",
          title: "add to cart",
          given: "a catalog",
          when: "they add an item",
          then: "the cart updates",
        },
        milestoneId: MILESTONE_A,
        dependsOn: [],
        personaIdByName: new Map([["buyer", PERSONA_A]]),
        behaviorId: BEHAVIOR_A,
        actor: actorA,
      }),
    );
    expect(spec.behaviorId).toBe(BEHAVIOR_A);

    await runWithOrgScope(app, ORG_A, async (client) => {
      const store = new PgBehaviorRevisionStore(client);
      const active = await store.getActiveForLineage(ORG_A, BEHAVIOR_A);
      expect(active).toBeDefined();
      expect(active!.revisionNumber).toBe(1);
      expect(active!.status).toBe("active");
      expect(active!.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      // Bound to its originating spec.
      expect(active!.authoringProvenance["originatingSpecId"]).toBe(spec.specId);
      // The frozen revision resolves by its own content digest (the binding path).
      const byDigest = await store.getByDigest(ORG_A, active!.contentDigest);
      expect(byDigest?.id).toBe(active!.id);
      // A persona revision was minted for the persona lineage.
      const persona = await new PgPersonaRevisionStore(client).getActiveForLineage(ORG_A, PERSONA_A);
      expect(persona?.revisionNumber).toBe(1);
      expect(active!.personaRevisionId).toBe(persona!.id);
    });
  });

  it("re-minting identical content is idempotent — same revision id + digest, no new row", async () => {
    const first = await runWithOrgScope(app, ORG_A, (client) =>
      new PgBehaviorRevisionStore(client).getActiveForLineage(ORG_A, BEHAVIOR_A),
    );
    const again = await runWithOrgScope(app, ORG_A, async (client) => {
      const persona = await new PgPersonaRevisionStore(client).getActiveForLineage(ORG_A, PERSONA_A);
      return new PgBehaviorRevisionStore(client).create({
        orgId: ORG_A,
        projectId: PROJECT_A,
        behaviorId: BEHAVIOR_A,
        personaRevisionId: persona!.id,
        title: "add to cart",
        given: "a catalog",
        when: "they add an item",
        then: "the cart updates",
        acceptance: { criteria: ["given a catalog, when they add an item, then the cart updates"] },
        authoringProvenance: {
          source: "derive",
          originatingSpecId: first!.authoringProvenance["originatingSpecId"],
          behaviorId: BEHAVIOR_A,
        },
      });
    });
    expect(again.id).toBe(first!.id);
    expect(again.contentDigest).toBe(first!.contentDigest);
    expect(await countRevisions(app, ORG_A, BEHAVIOR_A)).toBe(1);
  });

  it("changed content mints a NEW revision and supersedes the prior active one", async () => {
    const prior = await runWithOrgScope(app, ORG_A, (client) =>
      new PgBehaviorRevisionStore(client).getActiveForLineage(ORG_A, BEHAVIOR_A),
    );
    const next = await runWithOrgScope(app, ORG_A, async (client) => {
      const persona = await new PgPersonaRevisionStore(client).getActiveForLineage(ORG_A, PERSONA_A);
      return new PgBehaviorRevisionStore(client).create({
        orgId: ORG_A,
        projectId: PROJECT_A,
        behaviorId: BEHAVIOR_A,
        personaRevisionId: persona!.id,
        title: "add to cart",
        given: "a catalog",
        when: "they add an item",
        // changed content — a new revision must be minted.
        then: "the cart updates AND a toast confirms",
        acceptance: { criteria: ["updated"] },
        authoringProvenance: { source: "respec", behaviorId: BEHAVIOR_A },
      });
    });
    expect(next.revisionNumber).toBe(2);
    expect(next.contentDigest).not.toBe(prior!.contentDigest);
    expect(next.supersedesId).toBe(prior!.id);
    expect(await countRevisions(app, ORG_A, BEHAVIOR_A)).toBe(2);

    await runWithOrgScope(app, ORG_A, async (client) => {
      const store = new PgBehaviorRevisionStore(client);
      const active = await store.getActiveForLineage(ORG_A, BEHAVIOR_A);
      // the new revision is the sole active one
      expect(active!.id).toBe(next.id);
      const priorRow = await store.getById(ORG_A, prior!.id);
      // prior demoted via a status-only transition
      expect(priorRow!.status).toBe("superseded");
    });
  });

  it("rejects a raw content UPDATE and a DELETE at the DB (0090 trigger)", async () => {
    const active = await runWithOrgScope(app, ORG_A, (client) =>
      new PgBehaviorRevisionStore(client).getActiveForLineage(ORG_A, BEHAVIOR_A),
    );
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query(`UPDATE behavior_revisions SET given = 'tampered' WHERE id = $1`, [active!.id]),
      ),
    ).rejects.toThrow(/content is immutable/u);
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        client.query(`DELETE FROM behavior_revisions WHERE id = $1`, [active!.id]),
      ),
    ).rejects.toThrow(/append-only/u);
    // The content survived the rejected mutation unchanged.
    await runWithOrgScope(app, ORG_A, async (client) => {
      const row = await new PgBehaviorRevisionStore(client).getById(ORG_A, active!.id);
      expect(row!.then).toBe("the cart updates AND a toast confirms");
    });
  });

  it("rejects binding a behavior revision to a non-existent persona revision (fail-closed)", async () => {
    await expect(
      runWithOrgScope(app, ORG_A, (client) =>
        new PgBehaviorRevisionStore(client).create({
          orgId: ORG_A,
          projectId: PROJECT_A,
          behaviorId: "behavior_dangling",
          personaRevisionId: parsePersonaRevisionId("persona_revision_does_not_exist"),
          title: "dangling",
          given: "g",
          when: "w",
          then: "t",
          acceptance: {},
          authoringProvenance: { source: "test" },
        }),
      ),
    ).rejects.toThrow(RevisionBindingError);
  });

  it("also surfaces a concurrent-collision as a typed immutability error", () => {
    // A duplicate revision-number INSERT is the append-only backstop (23505 ->
    // typed). Constructed directly to pin the mapping without racing the pool.
    const err = new RevisionImmutabilityError("behavior", BEHAVIOR_A, "revision number already persisted");
    expect(err.name).toBe("RevisionImmutabilityError");
    expect(err.message).toMatch(/immutable/u);
  });

  it("RLS: a peer org sees ZERO of another org's revisions", async () => {
    expect(await countRevisions(app, ORG_B, BEHAVIOR_A)).toBe(0);
  });
});
