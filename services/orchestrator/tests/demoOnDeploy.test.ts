// Demos-as-evidence wiring (design doc § "Native Deployment And Demos"): a merged run
// whose deploy is VERIFIED gets its spec's BEHAVIORS exercised against the live deploy
// surface + per-behavior evidence recorded; a run with NO verified deploy is a clean
// no-op; a re-check after a prior demo is idempotent. Driven over a fake pool (the
// watcher's system-scoped reads) + the scripted deploy transport + a scripted web
// probe — no Postgres, no real provider, no live HTTP.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { getJobOrgId } from "@tanren/db";
import { DemoOnDeployWatcher } from "../src/engine/postMerge/demoOnDeploy.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { DemoWebProbe } from "../src/engine/demo/demoEvidence.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import { scriptedDeployTransport } from "./conformance/fakes/scriptedDeployTransport.js";

const RUN_ID = "run_demo";
const SPEC_ID = "spec_demo";
const PROJECT_ID = "proj_demo";
const ORG_ID = "org_demo";
const APP_ID = "vercel_app_1";
const DEPLOYMENT_ID = "vercel_deploy_1";

interface BehaviorSeed {
  id: string;
  title: string;
  surfacePath?: string;
}

interface PoolState {
  /** Whether a `deploy.verified` event exists for the run. */
  verified: boolean;
  /** Whether a prior `demo.completed` exists for the run (idempotency). */
  alreadyDemoed?: boolean;
  /** The org grant row (org_integrations) for the deploy provider. */
  grant?: { provider_kind: string; credential_ref: string; metadata: Record<string, unknown> };
  /** The spec's behaviors (returned by BehaviorStore.listForSpec). */
  behaviors: BehaviorSeed[];
}

const VERCEL_GRANT = {
  provider_kind: "deploy.vercel",
  credential_ref: "secret://org/deploy-token",
  metadata: { teamId: "team_abc", slug: "acme" },
};

function fakePool(state: PoolState): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string, _params?: readonly unknown[]) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    // loadVerifiedDeploy: the deploy.verified event + run/project + a prior-demo flag.
    if (/event_type = 'deploy\.verified'/u.test(sql)) {
      if (!state.verified) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            payload: { provider: "deploy.vercel", appId: APP_ID, deploymentId: DEPLOYMENT_ID },
            spec_id: SPEC_ID,
            project_id: PROJECT_ID,
            org_id: ORG_ID,
            demoed: state.alreadyDemoed === true,
          },
        ],
        rowCount: 1,
      };
    }
    // The org grant lookup (demoSurface resolution). `status` is NOT NULL DEFAULT
    // 'linked' on the real row; the store decodes it via the validated read seam.
    if (/FROM org_integrations WHERE org_id = \$1 AND provider_kind = \$2/u.test(sql)) {
      return state.grant === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ status: "linked", ...state.grant }], rowCount: 1 };
    }
    // BehaviorStore.listForSpec join.
    if (/FROM behaviors b/u.test(sql) || /INNER JOIN spec_behaviors/u.test(sql)) {
      return {
        rows: state.behaviors.map((b) => ({
          id: b.id,
          persona_id: "persona_1",
          title: b.title,
          given: "",
          when: "",
          // "then" is the BDD Given/When/Then column name, not a thenable.
          // eslint-disable-next-line unicorn/no-thenable
          then: "",
          description: null,
          metadata: b.surfacePath === undefined ? {} : { surfacePath: b.surfacePath },
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

// A web probe scripted per path: each behavior's resolved route gets a fixed status.
function scriptedProbe(byPath: Record<string, number>): DemoWebProbe & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    // eslint-disable-next-line @typescript-eslint/require-await
    async reach(url: string): Promise<number> {
      probed.push(url);
      return byPath[new URL(url).pathname] ?? 200;
    },
  };
}

async function run(state: PoolState, probe: DemoWebProbe, events: RecordingEventStore): Promise<void> {
  const watcher = new DemoOnDeployWatcher({
    pool: fakePool(state),
    secrets: secrets(),
    transport: scriptedDeployTransport("vercel", ["acme-web"]),
    eventStore: events,
    webProbe: probe,
  });
  await watcher.check(RUN_ID);
}

describe("DemoOnDeployWatcher (demos-as-evidence wiring)", () => {
  it("exercises the spec's behaviors against the verified deploy surface + records evidence", async () => {
    const probe = scriptedProbe({ "/links": 200, "/admin": 503 });
    const events = new RecordingEventStore();
    await run(
      {
        verified: true,
        grant: VERCEL_GRANT,
        behaviors: [
          { id: "beh_links", title: "Create a short link", surfacePath: "/links" },
          { id: "beh_admin", title: "View the admin dashboard", surfacePath: "/admin" },
        ],
      },
      probe,
      events,
    );

    // The demo resolved the live surface (the scripted transport's vercel URL, shaped
    // from the deployment id) + probed each behavior's route on it.
    expect(probe.probed).toEqual([
      `https://${DEPLOYMENT_ID}.vercel.app/links`,
      `https://${DEPLOYMENT_ID}.vercel.app/admin`,
    ]);
    // One evidence event per behavior, org-scoped, + a demo.completed summary.
    const recorded = events.appends.filter((a) => a.eventType === "demo.evidence.recorded");
    expect(recorded).toHaveLength(2);
    expect(recorded.every((a) => a.ambientOrgId === ORG_ID)).toBe(true);
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "web_url", behaviorCount: 2, passed: 1, failed: 1 });
    expect(JSON.stringify(events.appends)).not.toContain("deploy_token");
  });

  it("is a clean NO-OP when the run has no verified deploy (no demo, no error)", async () => {
    const events = new RecordingEventStore();
    await run({ verified: false, behaviors: [] }, scriptedProbe({}), events);
    expect(events.appends).toEqual([]);
  });

  it("is idempotent: a re-check after a prior demo records nothing new", async () => {
    const probe = scriptedProbe({ "/x": 200 });
    const events = new RecordingEventStore();
    await run(
      {
        verified: true,
        alreadyDemoed: true,
        grant: VERCEL_GRANT,
        behaviors: [{ id: "beh_x", title: "X", surfacePath: "/x" }],
      },
      probe,
      events,
    );
    expect(events.appends).toEqual([]);
    expect(probe.probed).toEqual([]);
  });

  it("records a demo.completed with zero counts when the spec has no behaviors (never silent)", async () => {
    const events = new RecordingEventStore();
    await run({ verified: true, grant: VERCEL_GRANT, behaviors: [] }, scriptedProbe({}), events);
    expect(events.appends.filter((a) => a.eventType === "demo.evidence.recorded")).toEqual([]);
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ behaviorCount: 0, passed: 0, failed: 0 });
  });

  it("fails LOUD when the verified deploy's org grant has gone missing (never a silent skip)", async () => {
    const events = new RecordingEventStore();
    await expect(
      run({ verified: true, behaviors: [{ id: "b", title: "B", surfacePath: "/b" }] }, scriptedProbe({}), events),
    ).rejects.toThrow(/no matching grant/u);
  });
});
