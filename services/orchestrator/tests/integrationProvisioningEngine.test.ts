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
import type pg from "pg";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { EventStore } from "./fakes/fakeEventStore.js";
import { FakeEventStore } from "./fakes/fakeEventStore.js";
import { FakeSentryProvisioner } from "./fakes/fakeSentryProvisioner.js";
import type { IntegrationProvisioner } from "../src/engine/contracts/integrationProvisioner.js";
import {
  provisionCapability,
  resolveProviderKind,
  type ProvisioningEngineDeps,
} from "../src/engine/integrations/provisioningEngine.js";

const ORG = "org_int_1";
const PROJECT = "proj_int_1";
const ACTOR = { kind: "operator", id: "user_a" } as const;
const TOKEN_REF = "org/org_int_1/sentry/token";

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
}

function stubPool(state: StubState): pg.Pool {
  let seq = 0;
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    // OrganizationsStore.getLogin (task #27 — deploy-app namespacing).
    if (text.includes("SELECT login FROM organizations")) {
      const orgId = String(params[0]);
      // Stub a deterministic test-org login so the deploy-namespacing rule has a
      // valid prefix; the SENTRY/SLACK provisioners in this file ignore it.
      return { rows: [{ login: orgId === ORG ? "test-tanren" : "unknown" }], rowCount: 1 };
    }
    // getGrant → OrgIntegrationsStore.get
    if (text.includes("FROM org_integrations") && text.includes("provider_kind = $2")) {
      const match = state.integrations.find((r) => r.org_id === params[0] && r.provider_kind === params[1]);
      if (match === undefined) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: "oi_1",
            org_id: match.org_id,
            provider_kind: match.provider_kind,
            credential_ref: match.credential_ref,
            metadata: match.metadata,
            capabilities: [],
            status: "linked",
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("SELECT config FROM projects")) {
      return { rows: [{ config: state.projectConfig }], rowCount: state.projectConfig === null ? 1 : 1 };
    }
    if (text.startsWith("UPDATE projects SET config")) {
      state.projectConfig = JSON.parse(String(params[0])) as Record<string, unknown>;
      return { rows: [], rowCount: 1 };
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
      if (existing !== undefined) {
        existing.name = String(params[4]);
        existing.config = String(params[6]);
        return { rows: [{ id: existing.id }], rowCount: 1 };
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
      return { rows: [{ id }], rowCount: 1 };
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
  return { query } as unknown as pg.Pool;
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
  const deps: ProvisioningEngineDeps = {
    client: stubPool(state),
    secrets,
    events: events as unknown as EventStore,
    actor: ACTOR,
    buildProvisioner: () => provisioner,
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
    expect(events.appended).toHaveLength(1);
    const ev = events.appended[0]!;
    expect(ev.eventType).toBe("integration.provisioned");
    expect(ev.projectId).toBe(PROJECT);
    expect(JSON.stringify(ev.payload)).not.toContain(stored!.value);
    expect((ev.payload as { secretRefNames: string[] }).secretRefNames).toEqual([dsnRef]);
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
    expect(events.appended).toHaveLength(0);
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

// Regression guard for the blocking bug: a provisioner that emits an
// inbox-source kind outside `inbox_sources_kind_check` (e.g. "sentry" instead of
// "errors") must FAIL persistence — the stub pool mirrors the real DB CHECK, so a
// future provider re-introducing a bad kind can't pass silently.
describe("provisionCapability — inbox kind CHECK realism", () => {
  it("rejects an inbox source whose kind violates inbox_sources_kind_check", async () => {
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
      client: stubPool(state),
      secrets,
      events: events as unknown as EventStore,
      actor: ACTOR,
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
    ).rejects.toThrow(/inbox_sources_kind_check/u);
    expect(state.inboxSources).toHaveLength(0);
  });
});
