// ds-composer — the RE-AUDIT proof that ds-3's F2D loop is no longer a DEAD path.
//
// Drives the REAL production producer (`composeProjectWebDesignSystem`) end-to-end
// over Postgres: a project whose HEAD design contract declares a dimension (so
// `withDerivedDesiredSurfaces` yields a real `desiredSurface`) with NO matching
// fragment in the org registry → the producer SELECTS the missing fragment → ds-3
// `runDesignFragmentAuthoring` actually FIRES (author → validate → atomic persist,
// real writer seam, a fixture answerer only at the provider boundary) → the ds-2 web
// artifact is built + published → the `design_system_releases` row is PUBLISHED →
// `resolveProjectWebDesignSystem` (the run-context reader) then RESOLVES it. The
// wiring/construction is production code (the producer); the answerer is the sole
// injected fixture. Idempotent: a second compose is a published-lineage no-op.
//
// Gated behind TANREN_RLS_DB_TEST=1 + owner/superuser DATABASE_URL, mirroring
// runExecutionContextWebDesign.integration.test.ts.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import type { EventStore } from "../src/engine/eventStore.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { parseDesignContract } from "../src/engine/design/designContract.js";
import { FilesystemArtifactStore } from "../src/engine/design/system/artifactStore.js";
import { composeProjectWebDesignSystem } from "../src/engine/design/system/composeProjectWebDesignSystem.js";
import { resolveProjectWebDesignSystem } from "../src/engine/design/system/designSystemStore.js";
import type { DesignFragmentDraftV1 } from "../src/engine/design/system/authoring/index.js";
import { DesignContractStore } from "../src/engine/repositories/designContracts.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_ID = "org_ds_composer";
const PROJECT_ID = "project_ds_composer";

function dbName(): string {
  return `tanren_ds_composer_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

/** A capturing EventStore — the injected event sink dependency (records the frozen
 * `designFragment.authoring.*` + `design.*` events the producer emits). */
class CapturingEventStore implements EventStore {
  readonly appended: Array<{ eventType: string; orgId: string; projectId?: string }> = [];
  async append(input: { eventType: string; orgId: string; projectId?: string }): Promise<void> {
    this.appended.push({ eventType: input.eventType, orgId: input.orgId, projectId: input.projectId });
  }
}

/** The provider boundary: a deterministic fixture answerer that authors a valid draft
 * for the requested slot (parsed from the prompt). Production wires the real allocating
 * Forge answerer through this SAME `AnswererAdapter<DesignFragmentDraftV1>` seam. */
function fixtureFragmentAnswerer(): AnswererAdapter<DesignFragmentDraftV1> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "test/ds-composer-fixture",
    async runAnswerer(opts) {
      const prompt = opts.prompt;
      const kind = /kind:\s+(\S+)/u.exec(prompt)?.[1] ?? "surface/components";
      const label = /label:\s+(.+)/u.exec(prompt)?.[1]?.trim() ?? "Components";
      const phase = /phase:\s+(\S+)/u.exec(prompt)?.[1] ?? "patterns-and-templates";
      const conformanceSuiteId =
        /conformanceSuiteId \(declare verbatim\): (.+)/u.exec(prompt)?.[1]?.trim() ??
        "surface.components.conformance.v1";
      const draft = {
        kind,
        label,
        phase,
        version: "1.0.0",
        targetCapabilities: ["shadcn"],
        requires: [],
        provides: [],
        dependsOn: [],
        conflicts: [],
        replaces: [],
        personaRefs: [],
        behaviorRefs: [],
        conformanceSuiteId,
        operations: [
          {
            operation: "addComponent",
            path: `components/${label}.tsx`,
            fileKind: "component-source",
            mediaType: "text/plain",
            content: "export const Composed = () => null;",
            executable: false,
          },
        ],
      };
      return opts.outputSchema.parse(draft);
    },
  };
}

describeDb("ds-composer — F2D fires and a web design release is published + resolved", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;
  let artifactRoot: string;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });
    artifactRoot = await mkdtemp(join(tmpdir(), "tanren-ds-composer-"));

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG_ID],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'DS Composer', 'https://example.test/ds-composer.git', 'main', 'runner:test', $2, '{"version":1}'::jsonb)`,
      [PROJECT_ID, ORG_ID],
    );
    // Seed the project HEAD design contract with ONE dimension → one desired surface.
    const contract = parseDesignContract({
      version: 1,
      domain: "saas-web",
      identity: "a calm operations console",
      intent: "a dense control surface that never surprises",
      dimensions: [
        { key: "components", label: "Components", intent: "composable primitives", guidance: "", personaRefs: [] },
      ],
    });
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      DesignContractStore.create(client, { orgId: ORG_ID, projectId: PROJECT_ID, contract }, { kind: "operator" }),
    );
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    if (artifactRoot !== undefined) await rm(artifactRoot, { recursive: true, force: true });
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("composes: F2D authors the missing fragment, the release publishes, and the reader resolves it", async () => {
    const events = new CapturingEventStore();
    const result = await composeProjectWebDesignSystem(
      {
        pool: runtimePool,
        artifactStore: new FilesystemArtifactStore(artifactRoot),
        fragmentAnswerer: fixtureFragmentAnswerer(),
        eventStore: events,
        createdBy: "tanren.ds-composer.test",
      },
      { orgId: ORG_ID, projectId: PROJECT_ID },
    );

    // F2D FIRED — the missing surface fragment was authored.
    expect(result).toBeDefined();
    expect(result?.alreadyPublished).toBe(false);
    expect(result?.authoredFragmentIds).toHaveLength(1);
    expect(result?.authoredFragmentIds[0]).toContain("surface/components-Components");

    // The authored fragment is durably persisted as VALIDATED (F2D's atomic persist).
    const fragments = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query<{ kind: string; status: string }>(
        "SELECT kind, status FROM design_fragments WHERE org_id = $1 AND kind = $2",
        [ORG_ID, "surface/components"],
      ),
    );
    expect(fragments.rows).toHaveLength(1);
    expect(fragments.rows[0]?.status).toBe("validated");

    // The frozen `designFragment.authoring.succeeded` event fired (F2D lifecycle).
    expect(events.appended.some((e) => e.eventType === "designFragment.authoring.succeeded")).toBe(true);

    // The release is PUBLISHED (state + canonical artifact + provenance).
    const release = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query<{ state: string; canonical_artifact_id: string | null }>(
        "SELECT state, canonical_artifact_id FROM design_system_releases WHERE org_id = $1 AND id = $2",
        [ORG_ID, result!.releaseId],
      ),
    );
    expect(release.rows[0]?.state).toBe("published");
    expect(release.rows[0]?.canonical_artifact_id).toBe(result!.artifactId);

    // THE READER LIGHTS UP — the exact run-context resolver now resolves a context.
    const resolved = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      resolveProjectWebDesignSystem(client, { orgId: ORG_ID, projectId: PROJECT_ID }),
    );
    expect(resolved).toBeDefined();
    expect(resolved?.designSystemId).toBe(result!.designSystemId);
    expect(resolved?.releaseId).toBe(result!.releaseId);
    expect(resolved?.artifactId).toBe(result!.artifactId);
  });

  it("catches a NEW fragment colliding with an EXISTING persisted fragment (batch gate over the REAL registry)", async () => {
    // The org already carries the `surface/components / Components` fragment (persisted
    // by the first test) whose file is `components/Components.tsx`. A SECOND project
    // declares a DIFFERENT surface — `surface/console` — that still labels "Components",
    // so the fixture authors it to the SAME path `components/Components.tsx`. It is a
    // genuinely MISSING slot (different kind), so F2D authors it; the batch gate then
    // composes it AGAINST the org's real present files (`loadPresentFiles` →
    // `listPresentFilesByOrg`) and MUST catch the cross-registry path collision. With
    // the old empty-stub `loadPresentFiles` this collision went undetected.
    const COLLIDING_PROJECT = "project_ds_composer_collide";
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'DS Composer Collide', 'https://example.test/ds-composer-collide.git', 'main', 'runner:test', $2, '{"version":1}'::jsonb)`,
      [COLLIDING_PROJECT, ORG_ID],
    );
    const contract = parseDesignContract({
      version: 1,
      domain: "saas-web",
      identity: "a second console",
      intent: "a surface whose authored file path collides with the org's existing registry",
      dimensions: [{ key: "console", label: "Components", intent: "collide on path", guidance: "", personaRefs: [] }],
    });
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      DesignContractStore.create(
        client,
        { orgId: ORG_ID, projectId: COLLIDING_PROJECT, contract },
        { kind: "operator" },
      ),
    );

    await expect(
      composeProjectWebDesignSystem(
        {
          pool: runtimePool,
          artifactStore: new FilesystemArtifactStore(artifactRoot),
          fragmentAnswerer: fixtureFragmentAnswerer(),
          eventStore: new CapturingEventStore(),
          createdBy: "tanren.ds-composer.test",
        },
        { orgId: ORG_ID, projectId: COLLIDING_PROJECT },
      ),
    ).rejects.toThrow(/design fragment authoring failed/u);

    // Fail-closed: the colliding NEW fragment was RETRACTED — no `surface/console` row
    // survives, and no release was published for the second project.
    const consoleRows = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query("SELECT id FROM design_fragments WHERE org_id = $1 AND kind = $2", [ORG_ID, "surface/console"]),
    );
    expect(consoleRows.rows).toHaveLength(0);
    const resolved = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      resolveProjectWebDesignSystem(client, { orgId: ORG_ID, projectId: COLLIDING_PROJECT }),
    );
    expect(resolved).toBeUndefined();
  });

  it("is idempotent — a second compose short-circuits on the published lineage (no re-author)", async () => {
    const events = new CapturingEventStore();
    const result = await composeProjectWebDesignSystem(
      {
        pool: runtimePool,
        artifactStore: new FilesystemArtifactStore(artifactRoot),
        fragmentAnswerer: fixtureFragmentAnswerer(),
        eventStore: events,
        createdBy: "tanren.ds-composer.test",
      },
      { orgId: ORG_ID, projectId: PROJECT_ID },
    );
    expect(result?.alreadyPublished).toBe(true);
    expect(result?.authoredFragmentIds).toHaveLength(0);
    // No second authoring run fired.
    expect(events.appended.some((e) => e.eventType === "designFragment.authoring.succeeded")).toBe(false);
    // Still exactly one persisted fragment (no duplicate authored).
    const fragments = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query("SELECT id FROM design_fragments WHERE org_id = $1 AND kind = $2", [ORG_ID, "surface/components"]),
    );
    expect(fragments.rows).toHaveLength(1);
  });
});
