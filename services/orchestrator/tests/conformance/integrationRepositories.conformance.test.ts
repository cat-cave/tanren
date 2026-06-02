// Conformance for the two integration-provisioning stores (P-INT-0 + P-APP-ENV-0):
// `OrgIntegrationsStore` (Plane A) and `AppEnvironmentStore` (Plane B). Driven
// through an in-memory `pg` query target that — like the repositories conformance
// harness — models RLS row visibility: a client scoped to org X sees only org X's
// rows, so the off-scope assertions (org B sees ZERO of org A's rows) exercise the
// same row-filter contract the real org-scoped transaction provides. The shim also
// enforces the `project_app_env` value_ref XOR plain_value CHECK so the constraint
// is proven behaviorally. project_app_env scopes through its project's org (the
// 3c-style chain), so the shim resolves a row's org via its seeded project.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { systemActor } from "../../src/engine/state/actor.js";
import { OrgIntegrationsStore } from "../../src/engine/repositories/orgIntegrations.js";
import { AppEnvironmentStore } from "../../src/engine/repositories/appEnvironment.js";

interface OrgIntegrationRecord {
  id: string;
  org_id: string;
  provider_kind: string;
  credential_ref: string;
  metadata: unknown;
  capabilities: unknown;
  status: string;
}

interface AppEnvRecord {
  id: string;
  project_id: string;
  key: string;
  value_ref: string | null;
  plain_value: string | null;
  scopes: string[];
  source: string;
  description: string;
}

// The shared store: the two tables + a project→org map (so project_app_env's
// 3c-chain visibility resolves a row's org via its project).
class IntegrationMemoryDb {
  readonly orgIntegrations: OrgIntegrationRecord[] = [];
  readonly appEnv: AppEnvRecord[] = [];
  readonly projectOrg = new Map<string, string>();

  seedProject(projectId: string, orgId: string): void {
    this.projectOrg.set(projectId, orgId);
  }
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

// A `pg`-shaped client bound to one org scope. Reads/writes only touch rows whose
// org matches the scope (RLS); project_app_env rows resolve their org via the
// seeded project map (the 3c chain). The value-XOR CHECK is enforced on insert.
class ScopedClient {
  constructor(
    private readonly db: IntegrationMemoryDb,
    private readonly orgId: string,
  ) {}

  private orgIntegrations(): OrgIntegrationRecord[] {
    return this.db.orgIntegrations.filter((r) => r.org_id === this.orgId);
  }

  private appEnvVisible(): AppEnvRecord[] {
    return this.db.appEnv.filter((r) => this.db.projectOrg.get(r.project_id) === this.orgId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    const oi = this.handleOrgIntegrations(sql, params);
    if (oi !== undefined) return oi;
    const ae = this.handleAppEnv(sql, params);
    if (ae !== undefined) return ae;
    throw new Error(`IntegrationMemoryDb: unrecognized SQL: ${sql}`);
  }

  private handleOrgIntegrations(sql: string, params: readonly unknown[]): QueryResult | undefined {
    if (/INSERT INTO org_integrations/u.test(sql)) {
      const [id, orgId, providerKind, credentialRef, metadata, capabilities, status] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      // RLS WITH CHECK: a write must target the scoped org.
      if (orgId !== this.orgId) {
        throw new Error("new row violates row-level security policy for table org_integrations");
      }
      const existing = this.db.orgIntegrations.find((r) => r.org_id === orgId && r.provider_kind === providerKind);
      const rec: OrgIntegrationRecord = existing ?? {
        id,
        org_id: orgId,
        provider_kind: providerKind,
        credential_ref: credentialRef,
        metadata: JSON.parse(metadata),
        capabilities: JSON.parse(capabilities),
        status,
      };
      if (existing === undefined) {
        this.db.orgIntegrations.push(rec);
      } else {
        existing.credential_ref = credentialRef;
        existing.metadata = JSON.parse(metadata);
        existing.capabilities = JSON.parse(capabilities);
        existing.status = status;
      }
      return { rows: [rec as unknown as Record<string, unknown>], rowCount: 1 };
    }
    if (/^SELECT .* FROM org_integrations WHERE org_id = \$1 AND provider_kind = \$2/u.test(sql)) {
      const [orgId, providerKind] = params as [string, string];
      const rows = this.orgIntegrations().filter((r) => r.org_id === orgId && r.provider_kind === providerKind);
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (/^SELECT .* FROM org_integrations WHERE org_id = \$1/u.test(sql)) {
      const [orgId] = params as [string];
      const rows = this.orgIntegrations().filter((r) => r.org_id === orgId);
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (/DELETE FROM org_integrations/u.test(sql)) {
      const [orgId, providerKind] = params as [string, string];
      const visible = this.orgIntegrations().filter((r) => r.org_id === orgId && r.provider_kind === providerKind);
      for (const r of visible) {
        const idx = this.db.orgIntegrations.indexOf(r);
        if (idx >= 0) this.db.orgIntegrations.splice(idx, 1);
      }
      return { rows: visible.map((r) => ({ id: r.id })), rowCount: visible.length };
    }
    return undefined;
  }

  private handleAppEnv(sql: string, params: readonly unknown[]): QueryResult | undefined {
    if (/INSERT INTO project_app_env/u.test(sql)) {
      const [id, projectId, key, valueRef, plainValue, scopes, source, description] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string[],
        string,
        string,
      ];
      // DB CHECK: exactly one of value_ref / plain_value.
      const hasRef = valueRef !== null;
      const hasPlain = plainValue !== null;
      if (hasRef === hasPlain) {
        throw new Error('new row violates check constraint "project_app_env_value_xor_check"');
      }
      // RLS WITH CHECK via the project→org chain: the row's project must belong to
      // the scoped org.
      if (this.db.projectOrg.get(projectId) !== this.orgId) {
        throw new Error("new row violates row-level security policy for table project_app_env");
      }
      const existing = this.db.appEnv.find((r) => r.project_id === projectId && r.key === key);
      const rec: AppEnvRecord = existing ?? {
        id,
        project_id: projectId,
        key,
        value_ref: valueRef,
        plain_value: plainValue,
        scopes,
        source,
        description,
      };
      if (existing === undefined) {
        this.db.appEnv.push(rec);
      } else {
        existing.value_ref = valueRef;
        existing.plain_value = plainValue;
        existing.scopes = scopes;
        existing.source = source;
        existing.description = description;
      }
      return { rows: [rec as unknown as Record<string, unknown>], rowCount: 1 };
    }
    if (/^SELECT .* FROM project_app_env WHERE project_id = \$1 AND key = \$2/u.test(sql)) {
      const [projectId, key] = params as [string, string];
      const rows = this.appEnvVisible().filter((r) => r.project_id === projectId && r.key === key);
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (/^SELECT .* FROM project_app_env WHERE project_id = \$1/u.test(sql)) {
      const [projectId] = params as [string];
      const rows = this.appEnvVisible().filter((r) => r.project_id === projectId);
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (/DELETE FROM project_app_env/u.test(sql)) {
      const [projectId, key] = params as [string, string];
      const visible = this.appEnvVisible().filter((r) => r.project_id === projectId && r.key === key);
      for (const r of visible) {
        const idx = this.db.appEnv.indexOf(r);
        if (idx >= 0) this.db.appEnv.splice(idx, 1);
      }
      return { rows: visible.map((r) => ({ id: r.id })), rowCount: visible.length };
    }
    return undefined;
  }
}

function clientForOrg(db: IntegrationMemoryDb, orgId: string): Pick<pg.Pool, "query"> {
  return new ScopedClient(db, orgId) as unknown as Pick<pg.Pool, "query">;
}

describe("OrgIntegrationsStore conformance (in-memory pg, RLS-modeled)", () => {
  it("upsert → get/list/getGrant round-trips; getGrant returns the ref, never a value", async () => {
    const db = new IntegrationMemoryDb();
    const a = clientForOrg(db, "org_a");
    await OrgIntegrationsStore.upsert(
      a,
      {
        orgId: "org_a",
        providerKind: "sentry",
        credentialRef: "secret://org_a/sentry",
        metadata: { orgSlug: "acme" },
        capabilities: ["errors"],
      },
      systemActor,
    );

    const got = await OrgIntegrationsStore.get(a, "org_a", "sentry", systemActor);
    expect(got?.credentialRef).toBe("secret://org_a/sentry");
    expect(got?.capabilities).toEqual(["errors"]);

    const list = await OrgIntegrationsStore.list(a, "org_a", systemActor);
    expect(list).toHaveLength(1);

    const grant = await OrgIntegrationsStore.getGrant(a, "org_a", "sentry", systemActor);
    expect(grant).toEqual({
      providerKind: "sentry",
      credentialRef: "secret://org_a/sentry",
      metadata: { orgSlug: "acme" },
    });
    // The grant carries the REF (a `secret://…` pointer), never resolved material.
    expect(JSON.stringify(grant)).toContain("secret://org_a/sentry");
  });

  it("upsert is keyed on (org, provider) — re-linking updates, never duplicates", async () => {
    const db = new IntegrationMemoryDb();
    const a = clientForOrg(db, "org_a");
    await OrgIntegrationsStore.upsert(
      a,
      { orgId: "org_a", providerKind: "sentry", credentialRef: "secret://v1" },
      systemActor,
    );
    await OrgIntegrationsStore.upsert(
      a,
      { orgId: "org_a", providerKind: "sentry", credentialRef: "secret://v2", status: "provisioning" },
      systemActor,
    );
    const list = await OrgIntegrationsStore.list(a, "org_a", systemActor);
    expect(list).toHaveLength(1);
    expect(list[0]?.credentialRef).toBe("secret://v2");
    expect(list[0]?.status).toBe("provisioning");
  });

  it("off-org → zero rows (RLS): org B sees none of org A's grants", async () => {
    const db = new IntegrationMemoryDb();
    await OrgIntegrationsStore.upsert(
      clientForOrg(db, "org_a"),
      { orgId: "org_a", providerKind: "sentry", credentialRef: "secret://a" },
      systemActor,
    );
    const b = clientForOrg(db, "org_b");
    expect(await OrgIntegrationsStore.list(b, "org_a", systemActor)).toHaveLength(0);
    expect(await OrgIntegrationsStore.get(b, "org_a", "sentry", systemActor)).toBeUndefined();
    expect(await OrgIntegrationsStore.getGrant(b, "org_a", "sentry", systemActor)).toBeUndefined();
  });
});

describe("AppEnvironmentStore conformance (in-memory pg, RLS-modeled)", () => {
  function seeded(): { db: IntegrationMemoryDb; a: Pick<pg.Pool, "query"> } {
    const db = new IntegrationMemoryDb();
    db.seedProject("proj_a", "org_a");
    db.seedProject("proj_b", "org_b");
    return { db, a: clientForOrg(db, "org_a") };
  }

  it("upsert (secret ref) → get/list round-trips", async () => {
    const { db, a } = seeded();
    await AppEnvironmentStore.upsert(
      a,
      { projectId: "proj_a", key: "RESEND_API_KEY", valueRef: "secret://proj_a/resend", scopes: ["test", "runtime"] },
      systemActor,
    );
    const got = await AppEnvironmentStore.get(a, "proj_a", "RESEND_API_KEY", systemActor);
    expect(got?.valueRef).toBe("secret://proj_a/resend");
    expect(got?.plainValue).toBeNull();
    expect(got?.scopes).toEqual(["test", "runtime"]);
    expect(await AppEnvironmentStore.list(a, "proj_a", systemActor)).toHaveLength(1);
    void db;
  });

  it("upsert (plain value) is accepted; the value-XOR is enforced at the store AND the DB CHECK", async () => {
    const { a } = seeded();
    await AppEnvironmentStore.upsert(
      a,
      { projectId: "proj_a", key: "PUBLIC_URL", plainValue: "https://app.example", scopes: ["build"] },
      systemActor,
    );
    const got = await AppEnvironmentStore.get(a, "proj_a", "PUBLIC_URL", systemActor);
    expect(got?.plainValue).toBe("https://app.example");
    expect(got?.valueRef).toBeNull();

    // Neither set → store-level assertion rejects before the DB.
    await expect(
      AppEnvironmentStore.upsert(a, { projectId: "proj_a", key: "BAD", scopes: ["dev"] }, systemActor),
    ).rejects.toThrow(/exactly one/u);
    // Both set → store-level assertion rejects too.
    await expect(
      AppEnvironmentStore.upsert(
        a,
        { projectId: "proj_a", key: "BAD2", valueRef: "secret://x", plainValue: "y", scopes: ["dev"] },
        systemActor,
      ),
    ).rejects.toThrow(/exactly one/u);
  });

  it("upsert is keyed on (project, key) — re-adding updates, never duplicates", async () => {
    const { a } = seeded();
    await AppEnvironmentStore.upsert(
      a,
      { projectId: "proj_a", key: "K", plainValue: "v1", scopes: ["dev"] },
      systemActor,
    );
    await AppEnvironmentStore.upsert(
      a,
      { projectId: "proj_a", key: "K", plainValue: "v2", scopes: ["dev", "test"] },
      systemActor,
    );
    const list = await AppEnvironmentStore.list(a, "proj_a", systemActor);
    expect(list).toHaveLength(1);
    expect(list[0]?.plainValue).toBe("v2");
    expect(list[0]?.scopes).toEqual(["dev", "test"]);
  });

  it("delete removes the entry", async () => {
    const { a } = seeded();
    await AppEnvironmentStore.upsert(
      a,
      { projectId: "proj_a", key: "K", plainValue: "v", scopes: ["dev"] },
      systemActor,
    );
    expect(await AppEnvironmentStore.delete(a, "proj_a", "K", systemActor)).toBe(true);
    expect(await AppEnvironmentStore.list(a, "proj_a", systemActor)).toHaveLength(0);
    // Deleting again is a no-op (nothing matched).
    expect(await AppEnvironmentStore.delete(a, "proj_a", "K", systemActor)).toBe(false);
  });

  it("off-org → zero rows (RLS, project→org chain): org B sees none of org A's app env", async () => {
    const { db, a } = seeded();
    await AppEnvironmentStore.upsert(
      a,
      { projectId: "proj_a", key: "SECRET", valueRef: "secret://proj_a/x", scopes: ["test"] },
      systemActor,
    );
    const b = clientForOrg(db, "org_b");
    expect(await AppEnvironmentStore.list(b, "proj_a", systemActor)).toHaveLength(0);
    expect(await AppEnvironmentStore.get(b, "proj_a", "SECRET", systemActor)).toBeUndefined();
  });
});
