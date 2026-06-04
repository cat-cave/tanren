// Deploy-on-merge ("a deploy happened") coverage: a merged run whose project has a
// deploy integration TRIGGERS a real deploy of the merged ref onto the Vercel/Fly
// app + attaches the runtime app env; a project with NO deploy integration is a
// clean no-op; a re-check after a prior deploy is idempotent; a configured-but-
// missing grant fails LOUD. Driven over a fake pool (the watcher's system-scoped
// reads) + the scripted deploy transport — no Postgres, no real provider.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { getJobOrgId } from "@tanren/db";
import { DeployOnMergeWatcher } from "../src/engine/postMerge/deployOnMerge.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import { scriptedDeployTransport, type ScriptedDeployTransport } from "./conformance/fakes/scriptedDeployTransport.js";

const RUN_ID = "run_dep";
const PROJECT_ID = "project_dep";
const ORG_ID = "org_dep";
const PR_URL = "https://github.com/acme/widget/pull/7";
const BRANCH = "feat/x";

interface PoolState {
  /** Whether the run merged. */
  merged: boolean;
  /** The project config (carries the deploy target when present). */
  config: Record<string, unknown>;
  /** The org grant row (org_integrations) for the deploy provider, when linked. */
  grant?: { provider_kind: string; credential_ref: string; metadata: Record<string, unknown> };
  /** Whether a prior deploy.triggered exists for the run (idempotency). */
  alreadyDeployed?: boolean;
  /** Runtime app-env rows (project_app_env) the attach flow reads. */
  appEnv?: Record<string, unknown>[];
}

function fakePool(state: PoolState): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string, _params?: readonly unknown[]) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (/event_type = 'merge\.completed'/u.test(sql)) {
      return state.merged ? { rows: [{ payload: { prNumber: 7 } }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/event_type = 'deploy\.triggered'/u.test(sql)) {
      return state.alreadyDeployed === true ? { rows: [{ id: "e1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/FROM runs r JOIN projects p/u.test(sql)) {
      return { rows: [{ project_id: PROJECT_ID, pr_url: PR_URL, branch: BRANCH }], rowCount: 1 };
    }
    if (/SELECT config, org_id FROM projects/u.test(sql)) {
      return { rows: [{ config: state.config, org_id: ORG_ID }], rowCount: 1 };
    }
    if (/FROM org_integrations WHERE org_id = \$1 AND provider_kind = \$2/u.test(sql)) {
      return state.grant === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...state.grant }], rowCount: 1 };
    }
    if (/FROM project_app_env WHERE project_id/u.test(sql)) {
      return { rows: state.appEnv ?? [], rowCount: (state.appEnv ?? []).length };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: unknown; ambientOrgId?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({ eventType: input.eventType, payload: input.payload, ambientOrgId: getJobOrgId() });
  }
}

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: "secret://org/deploy-token", value: "deploy_token" });
  void store.put({ ref: "secret://proj/resend", value: "re_live_secret" });
  return store;
}

// The scripted transport assigns the created app the id `vercel_app_1` — the
// provider-side handle the provisioner would have stored as `deployAppId`.
const VERCEL_APP_ID = "vercel_app_1";
const VERCEL_TARGET = { deployProvider: "deploy.vercel", deployAppId: VERCEL_APP_ID };
const VERCEL_GRANT = {
  provider_kind: "deploy.vercel",
  credential_ref: "secret://org/deploy-token",
  metadata: { teamId: "team_abc", slug: "acme" },
};

async function run(state: PoolState, transport: ScriptedDeployTransport, events: RecordingEventStore): Promise<void> {
  const watcher = new DeployOnMergeWatcher({
    pool: fakePool(state),
    secrets: secrets(),
    transport,
    eventStore: events,
  });
  await watcher.check(RUN_ID);
}

describe("DeployOnMergeWatcher (a deploy happened)", () => {
  it("triggers a real deploy of the merged ref + attaches runtime env + records deploy.triggered", async () => {
    // The app must exist on the provider for `deploy` to resolve it. Seed it via a
    // create POST so `listApps` returns it under the generated id (VERCEL_APP_ID).
    const transport = scriptedDeployTransport("vercel", []);
    await transport.request({
      method: "POST",
      url: "https://api.vercel.com/v9/projects",
      headers: {},
      body: { name: "acme-widget" },
    });
    const events = new RecordingEventStore();
    await run(
      {
        merged: true,
        config: VERCEL_TARGET,
        grant: VERCEL_GRANT,
        appEnv: [
          {
            project_id: PROJECT_ID,
            key: "RESEND_API_KEY",
            value_ref: "secret://proj/resend",
            plain_value: null,
            scopes: ["runtime"],
          },
        ],
      },
      transport,
      events,
    );

    // A real deploy fired against the deployment endpoint, with the merged ref.
    const triggered = transport.deploysTriggered();
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.body["gitSource"]).toEqual({ type: "github", repo: "acme/widget", ref: BRANCH });
    // The runtime env reached the deploy transport (keyed on the deployed app id).
    expect(transport.envByApp()[VERCEL_APP_ID]).toEqual({ RESEND_API_KEY: "re_live_secret" });
    // deploy.triggered recorded under the org scope, with a resolved URL (no secret).
    const deploy = events.appends.find((a) => a.eventType === "deploy.triggered");
    expect(deploy).toBeDefined();
    expect(deploy!.ambientOrgId).toBe(ORG_ID);
    const payload = deploy!.payload as Record<string, unknown>;
    expect(payload["provider"]).toBe("deploy.vercel");
    expect(payload["url"]).toMatch(/^https:\/\//u);
    expect(JSON.stringify(deploy)).not.toContain("re_live_secret");
  });

  it("is a clean NO-OP for a project with no deploy integration (no error, no deploy)", async () => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await run({ merged: true, config: {} }, transport, events);
    expect(transport.deploysTriggered()).toEqual([]);
    expect(events.appends).toEqual([]);
  });

  it("is a no-op when the run has not merged", async () => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await run({ merged: false, config: VERCEL_TARGET, grant: VERCEL_GRANT }, transport, events);
    expect(transport.deploysTriggered()).toEqual([]);
  });

  it("is idempotent: a re-check after a prior deploy triggers no second deploy", async () => {
    const transport = scriptedDeployTransport("vercel", []);
    const events = new RecordingEventStore();
    await run({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT, alreadyDeployed: true }, transport, events);
    expect(transport.deploysTriggered()).toEqual([]);
    expect(events.appends).toEqual([]);
  });

  it("fails LOUD when the project configures a deploy but the org has no matching grant", async () => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await expect(run({ merged: true, config: VERCEL_TARGET }, transport, events)).rejects.toThrow(/no matching grant/u);
  });
});
