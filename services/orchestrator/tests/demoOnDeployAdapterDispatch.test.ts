// Coverage for Bug 2 (Codex H3 #24): the demo-on-deploy watcher DISPATCHES to the
// deploy adapter CLASS matching the persisted provider kind — no longer hard-wired to
// `direct_api`. A `deploy.package_release` provider resolves through the
// `package_release` adapter (surface: `package`); a `deploy.manual_external` resolves
// through the `manual_external` adapter (surface: `web_url` / `download` from the
// attestation). Driven over scripted external drivers + a recording event store.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { getJobOrgId } from "@tanren/db";
import { DemoOnDeployWatcher } from "../src/engine/postMerge/demoOnDeploy.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { DemoWebProbe } from "../src/engine/demo/demoEvidence.js";
import type { DemoPackageProbe } from "../src/engine/demo/demoPackageArm.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import type { DeployHttpTransport } from "../src/engine/provisioners/deployTransport.js";
import { adapterKindForProviderKind } from "../src/engine/deploy/buildDeployAdapter.js";
import { PACKAGE_RELEASE_PROVIDER_KIND } from "../src/engine/deploy/packageReleaseDeployAdapter.js";
import { MANUAL_EXTERNAL_PROVIDER_KIND } from "../src/engine/deploy/manualExternalDeployAdapter.js";
import { scriptedPackageRegistry } from "./conformance/fakes/scriptedDeployDrivers.js";
import { InMemoryManualAttestationStore } from "../src/engine/deploy/manualExternalDeployAdapter.js";

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
  const query = async (sql: string) => {
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
    if (/FROM org_integrations WHERE org_id = \$1 AND provider_kind = \$2/u.test(sql)) {
      return state.grant === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ status: "linked", ...state.grant }], rowCount: 1 };
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
  void store.put({ ref: "secret://org/deploy-token", value: "deploy_token" });
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
  it("maps each non-direct provider to its owning adapter class", () => {
    expect(adapterKindForProviderKind("deploy.pulumi")).toBe("pulumi");
    expect(adapterKindForProviderKind("deploy.package_release")).toBe("package_release");
    expect(adapterKindForProviderKind("deploy.mobile_release")).toBe("mobile_release");
    expect(adapterKindForProviderKind("deploy.manual_external")).toBe("manual_external");
  });
  it("throws LOUD on an unknown provider kind — never a silent fallback to direct_api", () => {
    expect(() => adapterKindForProviderKind("deploy.mystery")).toThrow(/no registered DeployAdapter class/u);
  });
});

describe("DemoOnDeployWatcher — dispatches to the matching adapter class (Bug 2, Codex H3 #24)", () => {
  it("routes a package_release verified deploy through the `package_release` adapter + package arm", async () => {
    const registry = scriptedPackageRegistry();
    const events = new RecordingEventStore();
    // A scripted package probe: 200 on the coordinate the adapter's demoSurface resolves.
    let queriedCoordinate = "";
    const packageProbe: DemoPackageProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async resolve({ coordinate }) {
        queriedCoordinate = coordinate;
        return { status: 200, url: `https://mock/npm/${coordinate}` };
      },
    };
    const state: PoolState = {
      verified: true,
      provider: PACKAGE_RELEASE_PROVIDER_KIND,
      appId: "@acme/web",
      deploymentId: "@acme/web@1.2.3",
      grant: {
        provider_kind: PACKAGE_RELEASE_PROVIDER_KIND,
        credential_ref: "secret://org/deploy-token",
        metadata: { packageRegistry: "npm", packageName: "@acme/web" },
      },
      behaviors: [{ id: "beh_install", title: "install the CLI" }],
    };
    const watcher = new DemoOnDeployWatcher({
      pool: fakePool(state),
      secrets: secrets(),
      transport: NULL_TRANSPORT,
      eventStore: events,
      webProbe: stubWebProbe,
      packageProbe,
      packageRegistry: registry,
    });
    await watcher.check(RUN_ID);
    // The package_release adapter's demoSurface asked the registry — the arm then
    // exercised the resolved coordinate through the injected package probe.
    expect(queriedCoordinate).toBe("@acme/web@1.2.3");
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "package", passed: 1 });
    // No demo.failed — dispatch resolved to the right adapter without falling through
    // to direct_api's Vercel deploymentStatus (which would have thrown).
    expect(events.appends.find((a) => a.eventType === "demo.failed")).toBeUndefined();
    // No secret material leaked into the events (the deploy_token stayed inside the
    // registry client's bearer — the arm's evidence is public shape only).
    expect(JSON.stringify(events.appends)).not.toContain("deploy_token");
  });

  it("routes a manual_external verified deploy through the `manual_external` adapter + web arm", async () => {
    const attestations = new InMemoryManualAttestationStore();
    // The operator's out-of-band attestation the manual_external adapter's demoSurface
    // reads back. Same handle the adapter's deploy() would have stamped.
    await attestations.record("manual:proj_demo@main", {
      url: "https://attested.example.dev",
      surfaceKind: "web_url",
      source: { repo: "acme/web", ref: "main" },
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
        credential_ref: "secret://org/deploy-token",
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
        credential_ref: "secret://org/deploy-token",
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
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/no registered DeployAdapter class/u);
    const failed = events.appends.find((a) => a.eventType === "demo.failed");
    expect(failed).toBeDefined();
    expect(failed!.payload["reason"]).toBe("resolve_surface_failed");
    expect(failed!.payload["provider"]).toBe("deploy.mystery");
  });
});
