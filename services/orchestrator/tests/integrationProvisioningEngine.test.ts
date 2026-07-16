// engine tests: the capability → grant → discover → smart-default →
// provision/bind → persist → event flow, driven over an in-memory stub pool
// (keyed by SQL substring, mirroring candidateInbox.test.ts) + a FAKE
// IntegrationProvisioner (under tests/, never wired into prod) + an in-memory
// SecretStore. NO real DB, NO live provider API.
//
// Asserts:
//   - greenfield "enable sentry" → provisions a project + DSN + inbox_source,
//     all persisted; the artifact carries the DSN REF (never the value).
//   - brownfield "enable sentry" with a discovered match → BINDS it (no create).
//   - a not-linked org → a structured link-first response (not a crash).
//   - secret VALUES never appear in the outcome / event payload (refs only).
//   - org-scope: the persisted rows carry the request's org_id.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { FakeSentryProvisioner } from "./fakes/fakeSentryProvisioner.js";
import type { IntegrationProvisioner } from "../src/engine/contracts/integrationProvisioner.js";
import type { IntegrationQueryClient, IntegrationQueryResult } from "../src/engine/repositories/integrationQuery.js";
import {
  provisionCapability,
  resolveProviderKind,
  type ProvisioningEngineDeps,
} from "../src/engine/integrations/provisioningEngine.js";
import { PgIntegrationAuthority } from "../src/engine/integrations/integrationAuthorityImpl.js";
import { defaultIntegrationResourceConstraints } from "../src/engine/contracts/integrationAuthority.js";

const ORG = "org_int_1";
const PROJECT = "proj_int_1";
const ACTOR = { kind: "operator", id: "user_a" } as const;
const TOKEN_REF = "org/org_int_1/sentry/token/g/1";

// The exact `inbox_sources_kind_check` set (migration 0024). The stub pool below
// enforces it so a provisioner emitting a CHECK-violating inbox kind (the capability-onboarding
// blocking bug) FAILS the persistence test instead of silently passing.
const INBOX_KIND_CHECK = new Set(["issues", "errors", "system", "manual", "scheduled_audit"]);

// ---- in-memory stub pool ---------------------------------------------------

interface StubState {
  integrations: Array<{ org_id: string; provider_kind: string; credential_ref: string; metadata: unknown }>;
  inboxSources: Array<{ id: string; org_id: string; project_id: string; kind: string; name: string; config: string }>;
  notificationTargets: Array<{ id: string; org_id: string; channel_kind: string; destination: string; label: string }>;
  projectConfig: Record<string, unknown> | null;
  projectConfigRevision: number;
  configCasInterleave?: Record<string, unknown>;
}

function stubClient(state: StubState): IntegrationQueryClient {
  let seq = 0;
  const query = async (text: string, params: unknown[] = []): Promise<IntegrationQueryResult> => {
    if (text.includes("SELECT p.project_id, o.login AS org_slug")) {
      const found = params[0] === ORG && params[1] === PROJECT;
      return { rows: found ? [{ project_id: PROJECT, org_slug: "test-tanren" }] : [], rowCount: found ? 1 : 0 };
    }
    if (text.includes("SELECT connection_id, grant_id FROM project_integration_grant_selections")) {
      const match = state.integrations.find((row) => row.org_id === params[0] && row.provider_kind === params[2]);
      return {
        rows: match === undefined ? [] : [{ connection_id: "connection_1", grant_id: "grant_1" }],
        rowCount: match === undefined ? 0 : 1,
      };
    }
    if (text.includes("FROM org_integration_connections c")) {
      const matches = state.integrations.filter(
        (row) => row.org_id === params[0] && (params[2] === undefined || row.provider_kind === params[2]),
      );
      return {
        rows: matches.map((match) => ({
          connection_id: "connection_1",
          provider_kind: match.provider_kind,
          provider_principal_id: "account_1",
          display_name: "account_1",
          principal_metadata: match.metadata,
          connection_health: "healthy",
          connection_status: "active",
          current_auth_generation: 1,
          grant_id: "grant_1",
          grant_current_generation: 1,
          grant_status: "active",
          plane: "control",
          environment: "control",
          credential_ref: match.credential_ref.endsWith("/g/1") ? match.credential_ref : `${match.credential_ref}/g/1`,
          auth_expires_at: null,
          auth_status: "active",
          capabilities: ["errors", "notify", "deploy"],
          operations: ["discover", "provision", "bind"],
          provider_scopes: ["project:read", "project:write"],
          resource_constraints: defaultIntegrationResourceConstraints(),
          policy_revision: "integration-catalog.v2",
          consent_revision: "consent.test",
          grant_expires_at: null,
          grant_generation_status: "active",
          selected_auth_generation: 1,
          selected_grant_generation: 1,
          selected_connection_id: "connection_1",
          selected_grant_id: "grant_1",
        })),
        rowCount: matches.length,
      };
    }
    if (
      text.includes("SELECT config, config_revision::text AS revision,") &&
      text.includes("config IS NOT DISTINCT FROM") &&
      text.includes("FROM projects")
    ) {
      const next = JSON.parse(String(params[1])) as unknown;
      const current = state.projectConfig ?? {};
      return {
        rows: [
          {
            config: current,
            revision: String(state.projectConfigRevision),
            config_equal: JSON.stringify(current) === JSON.stringify(next),
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("SELECT config, config_revision::text AS revision FROM projects")) {
      return {
        rows: [{ config: state.projectConfig ?? {}, revision: String(state.projectConfigRevision) }],
        rowCount: 1,
      };
    }
    if (text.includes("SELECT config FROM projects")) {
      return { rows: [{ config: state.projectConfig }], rowCount: state.projectConfig === null ? 1 : 1 };
    }
    if (text.includes("config_revision = config_revision + 1") && text.includes("UPDATE projects")) {
      if (state.configCasInterleave !== undefined) {
        state.projectConfig = { ...state.projectConfig, ...state.configCasInterleave };
        state.projectConfigRevision += 1;
        state.configCasInterleave = undefined;
      }
      const expected = Number(params[2]);
      if (state.projectConfigRevision !== expected) {
        return { rows: [], rowCount: 0 };
      }
      const next = JSON.parse(String(params[0])) as Record<string, unknown>;
      if (JSON.stringify(state.projectConfig ?? {}) === JSON.stringify(next)) {
        return { rows: [], rowCount: 0 };
      }
      state.projectConfig = next;
      state.projectConfigRevision += 1;
      return {
        rows: [{ config: state.projectConfig, revision: String(state.projectConfigRevision) }],
        rowCount: 1,
      };
    }
    if (text.startsWith("UPDATE projects SET config")) {
      throw new Error("LWW UPDATE projects SET config is deleted — use revision CAS");
    }
    // inbox source: INSERT ... ON CONFLICT (org_id, project_id, kind) DO UPDATE.
    // The stub MIRRORS the real DB constraints so a bad kind can't pass silently:
    //   - inbox_sources_kind_check (migration 0024) → reject any kind outside the set
    //   - the unique index (migration 0053) → a matching row UPDATEs, never duplicates
    if (text.includes("INSERT INTO inbox_sources")) {
      const kind = String(params[3]);
      if (!INBOX_KIND_CHECK.has(kind)) {
        throw new Error(
          `new row for relation "inbox_sources" violates check constraint "inbox_sources_kind_check" (kind=${kind})`,
        );
      }
      const existing = state.inboxSources.find(
        (r) => r.org_id === String(params[1]) && r.project_id === String(params[2]) && r.kind === kind,
      );
      const sourceRow = (row: StubState["inboxSources"][number]) => ({
        id: row.id,
        org_id: row.org_id,
        project_id: row.project_id,
        kind: row.kind,
        name: row.name,
        detail: "",
        config: JSON.parse(row.config) as unknown,
        enabled: String(params[7]),
        auto_route: String(params[8]),
        state: "active",
        attention_code: null,
        attention_message: null,
        attention_observed_at: null,
        webhook_configured: false,
        retry_not_before: null,
      });
      if (existing !== undefined) {
        existing.name = String(params[4]);
        existing.config = String(params[6]);
        return { rows: [sourceRow(existing)], rowCount: 1 };
      }
      const id = String(params[0]);
      state.inboxSources.push({
        id,
        org_id: String(params[1]),
        project_id: String(params[2]),
        kind,
        name: String(params[4]),
        config: String(params[6]),
      });
      return { rows: [sourceRow(state.inboxSources.at(-1)!)], rowCount: 1 };
    }
    // notification target: INSERT ... ON CONFLICT (org_id, channel_kind, destination).
    if (text.includes("INSERT INTO notification_targets")) {
      const existing = state.notificationTargets.find(
        (r) =>
          r.org_id === String(params[1]) && r.channel_kind === String(params[2]) && r.destination === String(params[3]),
      );
      if (existing !== undefined) {
        existing.label = String(params[4]);
        return { rows: [{ id: existing.id }], rowCount: 1 };
      }
      seq += 1;
      const id = `notif_target_${seq}`;
      state.notificationTargets.push({
        id,
        org_id: String(params[1]),
        channel_kind: String(params[2]),
        destination: String(params[3]),
        label: String(params[4]),
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query };
}

class StubDatabase {
  inScope = false;
  readonly client: IntegrationQueryClient;

  constructor(state: StubState) {
    this.client = stubClient(state);
  }

  async withOrgScope<T>(_orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T> {
    this.inScope = true;
    try {
      return await work(this.client);
    } finally {
      this.inScope = false;
    }
  }
}

class OutsideTransactionProvisioner implements IntegrationProvisioner {
  constructor(
    private readonly inner: IntegrationProvisioner,
    private readonly database: StubDatabase,
  ) {}

  capability(): string[] {
    return this.inner.capability();
  }

  discover(...args: Parameters<IntegrationProvisioner["discover"]>) {
    this.assertOutsideScope();
    return this.inner.discover(...args);
  }

  provision(...args: Parameters<IntegrationProvisioner["provision"]>) {
    this.assertOutsideScope();
    return this.inner.provision(...args);
  }

  bind(...args: Parameters<IntegrationProvisioner["bind"]>) {
    this.assertOutsideScope();
    return this.inner.bind(...args);
  }

  private assertOutsideScope(): void {
    if (this.database.inScope) throw new Error("provider I/O ran inside an org-scoped database transaction");
  }
}

function freshState(linked: boolean): StubState {
  return {
    integrations: linked
      ? [
          {
            org_id: ORG,
            provider_kind: "sentry",
            credential_ref: TOKEN_REF,
            metadata: { orgSlug: "acme", team: "core" },
          },
        ]
      : [],
    inboxSources: [],
    notificationTargets: [],
    projectConfig: null,
    projectConfigRevision: 1,
  };
}

function depsFor(state: StubState): {
  deps: ProvisioningEngineDeps;
  events: FakeEventStore;
  provisioner: FakeSentryProvisioner;
} {
  const secrets = new InMemorySecretStore();
  const events = new FakeEventStore();
  const provisioner = new FakeSentryProvisioner(secrets);
  const database = new StubDatabase(state);
  const deps: ProvisioningEngineDeps = {
    database,
    secrets,
    events,
    actor: ACTOR,
    authority: new PgIntegrationAuthority(),
    buildProvisioner: () => new OutsideTransactionProvisioner(provisioner, database),
  };
  return { deps, events, provisioner };
}

describe("resolveProviderKind", () => {
  it("maps known capabilities to their canonical provider", () => {
    expect(resolveProviderKind("errors")).toBe("sentry");
    expect(resolveProviderKind("notify")).toBe("slack");
  });
  it("requires an explicit provider for the deploy capability", () => {
    expect(() => resolveProviderKind("deploy")).toThrow(/no single default/u);
    expect(resolveProviderKind("deploy", "deploy.vercel")).toBe("deploy.vercel");
    expect(() => resolveProviderKind("deploy", "sentry")).toThrow(/requires a deploy provider/u);
  });
});

describe("provisionCapability — greenfield enable sentry", () => {
  it("provisions a project + DSN + inbox_source, all persisted, refs only", async () => {
    const state = freshState(true);
    const { deps, events, provisioner } = depsFor(state);

    const outcome = await provisionCapability(deps, {
      orgId: ORG,
      projectId: PROJECT,
      capability: "errors",
      mode: "greenfield",
      name: "acme-web",
    });

    expect(outcome.status).toBe("provisioned");
    if (outcome.status !== "provisioned") return;
    expect(outcome.action).toBe("provision");
    // create, not bind
    expect(provisioner.created).toEqual(["acme-web"]);

    // inbox_source persisted under the request org/project.
    expect(state.inboxSources).toHaveLength(1);
    expect(state.inboxSources[0]!.org_id).toBe(ORG);
    expect(state.inboxSources[0]!.project_id).toBe(PROJECT);
    expect(state.inboxSources[0]!.kind).toBe("errors");
    // projects.config got the sentry slug.
    expect(state.projectConfig).toMatchObject({ sentryProjectSlug: "acme-web" });
    expect(outcome.surfaces.inboxSourceId).toBeDefined();
    expect(outcome.surfaces.projectConfigKeys).toContain("sentryProjectSlug");

    // The DSN ref is surfaced; the DSN VALUE is in the secret store, NOT the outcome.
    expect(outcome.secretRefNames.length).toBe(1);
    const dsnRef = outcome.secretRefNames[0]!;
    const stored = await deps.secrets.get(dsnRef);
    // a real DSN value lives only here, never in the outcome
    expect(stored?.value).toContain("https://");
    expect(JSON.stringify(outcome)).not.toContain(stored!.value);

    // The event carries refs only — never the DSN value.
    expect(events.events).toHaveLength(1);
    const ev = events.events[0]!;
    expect(ev.eventType).toBe("integration.provisioned");
    expect(ev.projectId).toBe(PROJECT);
    expect(JSON.stringify(ev.payload)).not.toContain(stored!.value);
    expect((ev.payload as { secretRefNames: string[] }).secretRefNames).toEqual([dsnRef]);
  });

  it("re-reads after a config CAS loss and preserves the concurrent governance write", async () => {
    const state = freshState(true);
    state.configCasInterleave = { governancePosture: "warn" };
    const { deps } = depsFor(state);
    const outcome = await provisionCapability(deps, {
      orgId: ORG,
      projectId: PROJECT,
      capability: "errors",
      mode: "greenfield",
      name: "acme-web",
    });
    expect(outcome.status).toBe("provisioned");
    expect(state.projectConfig).toMatchObject({ governancePosture: "warn", sentryProjectSlug: "acme-web" });
  });
});

describe("provisionCapability — brownfield enable sentry with a discovered match", () => {
  it("binds the discovered match instead of creating", async () => {
    const state = freshState(true);
    const { deps, provisioner } = depsFor(state);
    provisioner.existing = [{ id: "acme-web", label: "acme-web", metadata: {} }];

    const outcome = await provisionCapability(deps, {
      orgId: ORG,
      projectId: PROJECT,
      capability: "errors",
      mode: "brownfield",
      name: "acme-web",
    });

    expect(outcome.status).toBe("provisioned");
    if (outcome.status !== "provisioned") return;
    expect(outcome.action).toBe("bind");
    // never created a second project
    expect(provisioner.created).toEqual([]);
    expect(provisioner.bound).toEqual(["acme-web"]);
    expect(state.inboxSources).toHaveLength(1);
  });
});

describe("provisionCapability — not linked", () => {
  it("returns a structured link-first response, not a crash", async () => {
    const state = freshState(false);
    const { deps, events, provisioner } = depsFor(state);

    const outcome = await provisionCapability(deps, {
      orgId: ORG,
      projectId: PROJECT,
      capability: "errors",
      mode: "greenfield",
      name: "acme-web",
    });

    expect(outcome.status).toBe("not_linked");
    if (outcome.status !== "not_linked") return;
    expect(outcome.providerKind).toBe("sentry");
    expect(outcome.message).toMatch(/link sentry at the org level first/u);
    expect(outcome.linkAffordance).toEqual({ kind: "org_integration_link", providerKind: "sentry", orgId: ORG });
    // No provider write, no persistence, no event.
    expect(provisioner.created).toEqual([]);
    expect(provisioner.bound).toEqual([]);
    expect(state.inboxSources).toHaveLength(0);
    expect(events.events).toHaveLength(0);
  });
});

describe("provisionCapability — idempotent re-onboard", () => {
  it("does not create a second inbox source on re-provision", async () => {
    const state = freshState(true);
    const { deps } = depsFor(state);
    const req = {
      orgId: ORG,
      projectId: PROJECT,
      capability: "errors",
      mode: "greenfield" as const,
      name: "acme-web",
    };
    await provisionCapability(deps, req);
    await provisionCapability(deps, req);
    expect(state.inboxSources).toHaveLength(1);
  });
});

// Regression guard: an invalid provisioner kind is rejected at the typed
// persistence boundary before SQL, while the stub retains DB CHECK realism.
describe("provisionCapability — typed inbox kind boundary", () => {
  it("rejects an inbox source whose kind is outside the canonical SourceKind", async () => {
    const state = freshState(true);
    const secrets = new InMemorySecretStore();
    const events = new FakeEventStore();
    const badKindProvisioner: IntegrationProvisioner = {
      capability: () => ["errors"],
      discover: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      provision: async () => ({
        projectConfig: { sentryProjectSlug: "acme-web" },
        secretRefs: { SENTRY_DSN: "org/x/dsn" },
        // the bug: "sentry" is not in inbox_sources_kind_check
        inboxSource: { kind: "sentry", config: {} },
      }),
      bind: async () => ({ inboxSource: { kind: "sentry", config: {} } }),
    };
    const deps: ProvisioningEngineDeps = {
      database: new StubDatabase(state),
      secrets,
      events,
      actor: ACTOR,
      authority: new PgIntegrationAuthority(),
      buildProvisioner: () => badKindProvisioner,
    };
    await expect(
      provisionCapability(deps, {
        orgId: ORG,
        projectId: PROJECT,
        capability: "errors",
        mode: "greenfield",
        name: "acme-web",
      }),
    ).rejects.toThrow(/Invalid option/u);
    expect(state.inboxSources).toHaveLength(0);
  });
});
