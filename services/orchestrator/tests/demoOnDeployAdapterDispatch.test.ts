// Coverage for Bug 2 (Codex H3 #24 + #22): the demo-on-deploy watcher DISPATCHES to
// the deploy adapter CLASS matching the persisted provider kind — no longer hard-wired
// to `direct_api`. A `deploy.manual_external` resolves through the `manual_external`
// adapter (surface: `web_url` / `download` from the attestation). Driven over a
// scripted attestation store + a recording event store.
//
// H3 #22 closure: `deploy.pulumi` / `deploy.package_release` / `deploy.mobile_release`
// have NO concrete production driver on `main`, so their adapter classes are
// fixture-only. `adapterKindForProviderKind` now throws LOUD on them (never a silent
// map to a class the factory cannot build); the watcher's try/catch records the throw
// as `resolve_surface_failed` on the run's `demo.failed` event — the operator-facing
// "this adapter is not available in production" surface. The pre-#22 test that
// expected `deploy.package_release` DISPATCH to succeed is replaced by a test that
// asserts the fixture-only refusal.

import { describe, expect, it } from "vitest";
import { defaultIntegrationResourceConstraints } from "../src/engine/contracts/integrationAuthority.js";
import type pg from "pg";
import { getJobOrgId } from "@tanren/db";
import { DemoOnDeployWatcher } from "../src/engine/postMerge/demoOnDeploy.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { DemoWebProbe } from "../src/engine/demo/demoEvidence.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import type { DeployHttpTransport } from "../src/engine/provisioners/deployTransport.js";
import { adapterKindForProviderKind } from "../src/engine/deploy/buildDeployAdapter.js";
import {
  InMemoryManualAttestationStore,
  MANUAL_EXTERNAL_PROVIDER_KIND,
} from "../src/engine/deploy/manualExternalDeployAdapter.js";

const RUN_ID = "run_demo";
const SPEC_ID = "spec_demo";
const PROJECT_ID = "proj_demo";
const ORG_ID = "org_demo";

interface BehaviorSeed {
  id: string;
  title: string;
  metadata?: Record<string, unknown>;
}

interface PoolState {
  verified: boolean;
  grant?: { provider_kind: string; credential_ref: string; metadata: Record<string, unknown> };
  provider: string;
  appId: string;
  deploymentId: string;
  behaviors: BehaviorSeed[];
}

function fakePool(state: PoolState): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (/event_type = 'deploy\.verified'/u.test(sql)) {
      if (!state.verified) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            payload: { provider: state.provider, appId: state.appId, deploymentId: state.deploymentId },
            spec_id: SPEC_ID,
            project_id: PROJECT_ID,
            org_id: ORG_ID,
            demoed: false,
          },
        ],
        rowCount: 1,
      };
    }
    if (/SELECT connection_id, grant_id FROM project_integration_grant_selections/u.test(sql)) {
      const selected = state.grant !== undefined && state.grant.provider_kind === params[2];
      return selected
        ? { rows: [{ connection_id: "connection_demo", grant_id: "grant_demo" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM org_integration_connections c/u.test(sql)) {
      if (state.grant === undefined) return { rows: [], rowCount: 0 };
      if (/project_integration_grant_selections/u.test(sql) || /selected_auth_generation/u.test(sql)) {
        const credentialRef = (state.grant.credential_ref ?? "secret://org/deploy-token/g/1").includes("/g/")
          ? (state.grant.credential_ref ?? "secret://org/deploy-token/g/1")
          : `${state.grant.credential_ref ?? "secret://org/deploy-token"}/g/1`;
        return {
          rows: [
            {
              connection_id: "connection_demo",
              provider_kind: state.grant.provider_kind,
              provider_principal_id: "account_demo",
              display_name: "account_demo",
              principal_metadata: state.grant.metadata ?? {},
              connection_health: "healthy",
              connection_status: "active",
              current_auth_generation: 1,
              grant_id: "grant_demo",
              grant_current_generation: 1,
              grant_status: "active",
              plane: "control",
              environment: "control",
              credential_ref: credentialRef,
              auth_expires_at: null,
              auth_status: "active",
              capabilities: ["deploy"],
              operations: ["resolve_demo_surface"],
              provider_scopes: [],
              resource_constraints: defaultIntegrationResourceConstraints(),
              policy_revision: "integration-catalog.v1",
              consent_revision: "consent.test",
              grant_expires_at: null,
              grant_generation_status: "active",
              selected_auth_generation: 1,
              selected_grant_generation: 1,
              selected_connection_id: "connection_demo",
              selected_grant_id: "grant_demo",
            },
          ],
          rowCount: 1,
        };
      }
      return {
        rows: [
          {
            connection_id: "connection_demo",
            grant_id: "grant_demo",
            org_id: ORG_ID,
            provider_kind: state.grant.provider_kind,
            provider_principal_id: "account_demo",
            principal_kind: "team",
            display_name: "account_demo",
            health: "healthy",
            connection_status: "active",
            current_auth_generation: 1,
            grant_generation: 1,
            grant_status: "active",
            auth_expires_at: null,
            provider_scopes: [],
            operation_id: null,
            operation_stage: null,
            operation_status: null,
            selected_for_project: true,
          },
        ],
        rowCount: 1,
      };
    }
    if (/FROM behaviors b/u.test(sql) || /INNER JOIN spec_behaviors/u.test(sql)) {
      return {
        rows: state.behaviors.map((b) => ({
          id: b.id,
          persona_id: "persona_1",
          title: b.title,
          given: "",
          when: "",
          // eslint-disable-next-line unicorn/no-thenable
          then: "",
          description: null,
          metadata: b.metadata ?? {},
          created_at: new Date(),
          updated_at: new Date(),
        })),
        rowCount: state.behaviors.length,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: Record<string, unknown>; ambientOrgId?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({
      eventType: input.eventType,
      payload: input.payload as Record<string, unknown>,
      ambientOrgId: getJobOrgId(),
    });
  }
}

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: "secret://org/deploy-token/g/1", value: "deploy_token" });
  return store;
}

// A no-op transport — the `direct_api` code path is not exercised in this test suite
// (dispatch resolves to a non-direct adapter class). Present only because the watcher
// constructor requires it.
const NULL_TRANSPORT: DeployHttpTransport = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async request() {
    throw new Error("deploy transport should not be called for non-direct dispatch tests");
  },
};

const stubWebProbe: DemoWebProbe = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async reach() {
    throw new Error("web probe should not be called on a non-web surface");
  },
};

describe("adapterKindForProviderKind — provider → adapter class mapping (Bug 2)", () => {
  it("maps direct_api providers to the `direct_api` adapter class", () => {
    expect(adapterKindForProviderKind("deploy.vercel")).toBe("direct_api");
    expect(adapterKindForProviderKind("deploy.flyio")).toBe("direct_api");
  });
  it("maps deploy.manual_external to the `manual_external` adapter class", () => {
    expect(adapterKindForProviderKind("deploy.manual_external")).toBe("manual_external");
  });
  it("throws LOUD on fixture-only providers (pulumi / package_release / mobile_release — H3 #22)", () => {
    // These providers have no concrete driver on `main`; mapping them to their
    // adapter class would create the "you can pick it but can't build it" split
    // the fix targets. The seam refuses them with the same "not a registered
    // DeployAdapter class" diagnostic the unknown-provider path uses.
    expect(() => adapterKindForProviderKind("deploy.pulumi")).toThrow(/no registered DeployAdapter class/u);
    expect(() => adapterKindForProviderKind("deploy.package_release")).toThrow(/no registered DeployAdapter class/u);
    expect(() => adapterKindForProviderKind("deploy.mobile_release")).toThrow(/no registered DeployAdapter class/u);
  });
  it("throws LOUD on an unknown provider kind — never a silent fallback to direct_api", () => {
    expect(() => adapterKindForProviderKind("deploy.mystery")).toThrow(/no registered DeployAdapter class/u);
  });
});

describe("DemoOnDeployWatcher — dispatches to the matching adapter class (Bug 2, Codex H3 #22 + #24)", () => {
  it("records a demo.failed with reason 'resolve_surface_failed' when the persisted provider is fixture-only (H3 #22)", async () => {
    const events = new RecordingEventStore();
    // A persisted `deploy.package_release` run: this could only exist if a previous
    // build of the orchestrator wrote it before #22 was closed. The watcher must
    // fail LOUD (never silently pretend to demo) — the operator-facing surface is
    // the durable `demo.failed` event with a clear reason.
    const state: PoolState = {
      verified: true,
      provider: "deploy.package_release",
      appId: "@acme/web",
      deploymentId: "@acme/web@1.2.3",
      grant: {
        provider_kind: "deploy.package_release",
        credential_ref: "secret://org/deploy-token/g/1",
        metadata: {},
      },
      behaviors: [{ id: "beh_install", title: "install the CLI" }],
    };
    const watcher = new DemoOnDeployWatcher({
      pool: fakePool(state),
      secrets: secrets(),
      transport: NULL_TRANSPORT,
      eventStore: events,
      webProbe: stubWebProbe,
    });
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/no registered DeployAdapter class/u);
    const failed = events.appends.find((a) => a.eventType === "demo.failed");
    expect(failed).toBeDefined();
    expect(failed!.payload["reason"]).toBe("resolve_surface_failed");
    expect(failed!.payload["provider"]).toBe("deploy.package_release");
    // No secret material leaked into the events.
    expect(JSON.stringify(events.appends)).not.toContain("deploy_token");
  });

  it("routes a manual_external verified deploy through the `manual_external` adapter + web arm", async () => {
    const attestations = new InMemoryManualAttestationStore();
    // The operator's out-of-band attestation the manual_external adapter's demoSurface
    // reads back. Same handle the adapter's deploy() would have stamped.
    await attestations.record({
      deploymentId: "manual:proj_demo@main",
      orgId: "org_demo",
      projectId: "proj_demo",
      appId: "proj_demo",
      attestation: {
        url: "https://attested.example.dev",
        surfaceKind: "web_url",
        source: { repo: "acme/web", ref: "main" },
      },
    });
    // demoSurface reads confirmed rows; the test attestation must reflect the
    // operator-confirmed lifecycle state the adapter enforces.
    await attestations.confirm({
      deploymentId: "manual:proj_demo@main",
      orgId: "org_demo",
      confirmedBy: "user_demo_operator",
    });
    let webProbeUrl = "";
    const webProbe: DemoWebProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async reach(url) {
        webProbeUrl = url;
        return 200;
      },
    };
    const events = new RecordingEventStore();
    const state: PoolState = {
      verified: true,
      provider: MANUAL_EXTERNAL_PROVIDER_KIND,
      appId: "proj_demo",
      deploymentId: "manual:proj_demo@main",
      grant: {
        provider_kind: MANUAL_EXTERNAL_PROVIDER_KIND,
        credential_ref: "secret://org/deploy-token/g/1",
        metadata: { manualExternalUrl: "https://attested.example.dev", manualExternalKind: "web_url" },
      },
      behaviors: [{ id: "beh_home", title: "home loads" }],
    };
    const watcher = new DemoOnDeployWatcher({
      pool: fakePool(state),
      secrets: secrets(),
      transport: NULL_TRANSPORT,
      eventStore: events,
      webProbe,
      manualAttestations: attestations,
    });
    await watcher.check(RUN_ID);
    // The manual_external adapter's demoSurface resolved to the attested URL; the web
    // arm probed it — dispatch reached the RIGHT adapter class.
    expect(webProbeUrl).toBe("https://attested.example.dev/");
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "web_url", passed: 1 });
    expect(events.appends.find((a) => a.eventType === "demo.failed")).toBeUndefined();
  });

  it("records a demo.failed with reason 'resolve_surface_failed' for an unknown provider (dispatch fails LOUD)", async () => {
    const events = new RecordingEventStore();
    const state: PoolState = {
      verified: true,
      provider: "deploy.mystery",
      appId: "app_1",
      deploymentId: "d_1",
      grant: {
        provider_kind: "deploy.mystery",
        credential_ref: "secret://org/deploy-token/g/1",
        metadata: {},
      },
      behaviors: [{ id: "b", title: "B" }],
    };
    const watcher = new DemoOnDeployWatcher({
      pool: fakePool(state),
      secrets: secrets(),
      transport: NULL_TRANSPORT,
      eventStore: events,
      webProbe: stubWebProbe,
    });
    // Unknown provider kinds fail closed at authorizeOperation (no fabricated lease).
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/deploy grant ineligible|unknown_provider_kind/u);
    const failed = events.appends.find((a) => a.eventType === "demo.failed");
    expect(failed).toBeDefined();
    expect(failed!.payload["reason"]).toBe("resolve_surface_failed");
    expect(failed!.payload["provider"]).toBe("deploy.mystery");
  });
});
