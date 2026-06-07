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
import { scriptedUrlProbe, instantVerifyPollPolicy } from "./conformance/fakes/scriptedUrlProbe.js";

const RUN_ID = "run_dep";
const PROJECT_ID = "project_dep";
const ORG_ID = "org_dep";
const PR_URL = "https://github.com/acme/widget/pull/7";
const MERGE_SHA = "abc1234def5678901234567890abcdef12345678";
const PRIOR_DEPLOYMENT_ID = "vercel_dep_prior";

interface PoolState {
  /** Whether the run merged. */
  merged: boolean;
  /** The project config (carries the deploy target when present). */
  config: Record<string, unknown>;
  /** The org grant row (org_integrations) for the deploy provider, when linked. */
  grant?: { provider_kind: string; credential_ref: string; metadata: Record<string, unknown> };
  /** Whether a prior deploy.triggered exists for the run (resume-verify path). */
  alreadyDeployed?: boolean;
  /** Whether a prior deploy.verified exists (full idempotency — skip entirely). */
  alreadyVerified?: boolean;
  /** Whether a prior deploy.failed exists (TERMINAL — skip entirely, no self-loop). */
  alreadyFailed?: boolean;
  /** Omit mergeSha from merge.completed (a merge that recorded no SHA — fail loud). */
  noMergeSha?: boolean;
  /** Runtime app-env rows (project_app_env) the attach flow reads. */
  appEnv?: Record<string, unknown>[];
}

function fakePool(state: PoolState): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string, _params?: readonly unknown[]) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (/event_type = 'merge\.completed'/u.test(sql)) {
      if (!state.merged) return { rows: [], rowCount: 0 };
      const payload = state.noMergeSha === true ? { prNumber: 7 } : { prNumber: 7, mergeSha: MERGE_SHA };
      return { rows: [{ payload }], rowCount: 1 };
    }
    if (/event_type IN \('deploy\.verified', 'deploy\.failed'\)/u.test(sql)) {
      // The TERMINAL gate (alreadyTerminal): a prior deploy.verified OR deploy.failed.
      return state.alreadyVerified === true || state.alreadyFailed === true
        ? { rows: [{ id: "t1" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/event_type = 'deploy\.triggered'/u.test(sql)) {
      return state.alreadyDeployed === true
        ? { rows: [{ payload: { deploymentId: PRIOR_DEPLOYMENT_ID } }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM runs r WHERE/u.test(sql)) {
      return { rows: [{ project_id: PROJECT_ID, pr_url: PR_URL }], rowCount: 1 };
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
// `version: 1` mirrors a real persisted project config — the deploy watcher parses
// it through the strict migrator to resolve the governance policy version for the
// deploy audit record (a missing version is a LOUD error in production, never a default).
const VERCEL_TARGET = { version: 1, deployProvider: "deploy.vercel", deployAppId: VERCEL_APP_ID };
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
    // Inject the scripted smoke probe + instant poll so the post-trigger `verify`
    // runs over the scripted transport (no live network / no real timers). The
    // scripted transport reports READY by default, so verify polls once + smokes 200.
    urlProbe: scriptedUrlProbe(),
    verifyPoll: instantVerifyPollPolicy(),
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
    // The merged COMMIT SHA, not the (now-deleted) PR branch.
    expect(triggered[0]!.body["gitSource"]).toEqual({ type: "github", repo: "acme/widget", ref: MERGE_SHA });
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
    // AUDIT-EVIDENCE BASELINE: the deploy carries the governance policy version + the
    // initiating actor (the autonomous service, no approver) + a NON-SECRET artifact
    // provenance ref (the deployment handle bound to the merged ref, no checksum here).
    expect(payload["policyVersion"]).toBe(1);
    expect(payload["initiatingActor"]).toEqual({ kind: "service", id: "tanren-engine" });
    expect(payload["approvingActor"]).toBeUndefined();
    expect(payload["artifact"]).toEqual({ provenanceRef: `deploy.vercel:vercel_deploy_1@${MERGE_SHA}` });
    expect((payload["artifact"] as Record<string, unknown>)["checksum"]).toBeUndefined();

    // The deploy is PROVEN, not fire-and-forget: verify polled to READY + smoked the
    // URL, and recorded deploy.verified (provider + url + state + smoke status).
    const verified = events.appends.find((a) => a.eventType === "deploy.verified");
    expect(verified).toBeDefined();
    expect(verified!.ambientOrgId).toBe(ORG_ID);
    const vPayload = verified!.payload as Record<string, unknown>;
    expect(vPayload["provider"]).toBe("deploy.vercel");
    expect(vPayload["state"]).toBe("READY");
    expect(vPayload["smokeStatus"]).toBe(200);
    expect(vPayload["url"]).toMatch(/^https:\/\//u);
    expect(JSON.stringify(verified)).not.toContain("deploy_token");
    // The verify carries the SAME audit envelope (governing deploy action).
    expect(vPayload["policyVersion"]).toBe(1);
    expect(vPayload["initiatingActor"]).toEqual({ kind: "service", id: "tanren-engine" });
  });

  it("fails LOUD when the triggered deploy never becomes READY (verify guard)", async () => {
    const transport = scriptedDeployTransport("vercel", []);
    await transport.request({
      method: "POST",
      url: "https://api.vercel.com/v9/projects",
      headers: {},
      body: { name: "acme-widget" },
    });
    const events = new RecordingEventStore();
    const watcher = new DeployOnMergeWatcher({
      pool: fakePool({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT }),
      secrets: secrets(),
      transport,
      eventStore: events,
      urlProbe: scriptedUrlProbe(),
      verifyPoll: instantVerifyPollPolicy(3),
      verifyMaxAttempts: 2,
    });
    // The triggered deployment reports ERROR on every attempt — verify exhausts its
    // bounded retry, escalates LOUD (deploy.failed), and re-throws. No deploy.verified.
    transport.scriptDeploymentStates("vercel_deploy_1", ["ERROR"]);
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/FAILURE state 'ERROR'/u);
    expect(events.appends.find((a) => a.eventType === "deploy.verified")).toBeUndefined();
    const failed = events.appends.find((a) => a.eventType === "deploy.failed");
    expect(failed).toBeDefined();
    expect(failed!.ambientOrgId).toBe(ORG_ID);
    const fPayload = failed!.payload as Record<string, unknown>;
    expect(fPayload["attempts"]).toBe(2);
    // The reason is a FIXED non-secret summary — NOT the raw verify error (which could
    // embed provider response text). The provider state string must NOT be persisted.
    expect(fPayload["reason"]).toContain("did not reach a live deployment");
    expect(fPayload["reason"]).not.toMatch(/ERROR/u);
    expect(JSON.stringify(failed)).not.toContain("deploy_token");
  });

  it("is TERMINAL on deploy.failed: a re-check after a prior failure is a no-op (no self-loop)", async () => {
    // The self-loop guard: deploy.failed is run-scoped, so its append wakes the
    // post-merge subscriber. A prior deploy.failed must gate check() to a no-op —
    // never re-verify the still-failed deployment nor append a second deploy.failed.
    const transport = scriptedDeployTransport("vercel", []);
    await transport.request({
      method: "POST",
      url: "https://api.vercel.com/v9/projects",
      headers: {},
      body: { name: "acme-widget" },
    });
    const events = new RecordingEventStore();
    await run({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT, alreadyFailed: true }, transport, events);
    expect(events.appends).toHaveLength(0);
    expect(transport.deploysTriggered()).toEqual([]);
  });

  it("RECOVERS when a transient verify failure clears on a retry (no deploy.failed)", async () => {
    const transport = scriptedDeployTransport("vercel", []);
    await transport.request({
      method: "POST",
      url: "https://api.vercel.com/v9/projects",
      headers: {},
      body: { name: "acme-widget" },
    });
    const events = new RecordingEventStore();
    const watcher = new DeployOnMergeWatcher({
      pool: fakePool({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT }),
      secrets: secrets(),
      transport,
      eventStore: events,
      urlProbe: scriptedUrlProbe(),
      verifyPoll: instantVerifyPollPolicy(),
      verifyMaxAttempts: 2,
    });
    // Attempt 1 reads ERROR (a transient blip → throws); the in-process retry's
    // attempt 2 reads READY → the deploy is proven live. No deploy.failed escalation.
    transport.scriptDeploymentStates("vercel_deploy_1", ["ERROR", "READY"]);
    await watcher.check(RUN_ID);
    expect(events.appends.find((a) => a.eventType === "deploy.verified")).toBeDefined();
    expect(events.appends.find((a) => a.eventType === "deploy.failed")).toBeUndefined();
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

  it("is idempotent on SUCCESS: a re-check after a VERIFIED deploy skips entirely", async () => {
    const transport = scriptedDeployTransport("vercel", []);
    const events = new RecordingEventStore();
    await run({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT, alreadyVerified: true }, transport, events);
    expect(transport.deploysTriggered()).toEqual([]);
    expect(events.appends).toEqual([]);
  });

  it("RESUMES verification after a prior unverified trigger — re-verifies, never re-triggers", async () => {
    // A transient verify failure left `deploy.triggered` but no `deploy.verified`.
    // The re-check must NOT re-deploy (the artifact is live); it re-verifies the SAME
    // deployment (the prior deploymentId) and records deploy.verified. This is the fix
    // for a transient verify failure permanently dead-ending the deploy.
    const transport = scriptedDeployTransport("vercel", []);
    // Seed the app so verify can resolve the prior deployment's status under the grant.
    await transport.request({
      method: "POST",
      url: "https://api.vercel.com/v9/projects",
      headers: {},
      body: { name: "acme-widget" },
    });
    const events = new RecordingEventStore();
    await run({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT, alreadyDeployed: true }, transport, events);
    // No fresh deploy was triggered.
    expect(transport.deploysTriggered()).toEqual([]);
    // Verification actually polled the PRIOR deployment's status (not a no-op).
    expect(transport.statusPolls(PRIOR_DEPLOYMENT_ID)).toBeGreaterThan(0);
    // Verification ran against the PRIOR deployment and now succeeded.
    const verified = events.appends.find((a) => a.eventType === "deploy.verified");
    expect(verified).toBeDefined();
    expect((verified!.payload as Record<string, unknown>)["deploymentId"]).toBe(PRIOR_DEPLOYMENT_ID);
    expect(events.appends.find((a) => a.eventType === "deploy.triggered")).toBeUndefined();
  });

  it("fails LOUD when merge.completed recorded no mergeSha (cannot determine the merged commit)", async () => {
    const transport = scriptedDeployTransport("vercel", []);
    const events = new RecordingEventStore();
    const watcher = new DeployOnMergeWatcher({
      pool: fakePool({ merged: true, noMergeSha: true, config: VERCEL_TARGET, grant: VERCEL_GRANT }),
      secrets: secrets(),
      transport,
      eventStore: events,
      urlProbe: scriptedUrlProbe(),
      verifyPoll: instantVerifyPollPolicy(),
    });
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/no mergeSha/u);
    expect(transport.deploysTriggered()).toEqual([]);
  });

  it("fails LOUD when the project configures a deploy but the org has no matching grant", async () => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await expect(run({ merged: true, config: VERCEL_TARGET }, transport, events)).rejects.toThrow(/no matching grant/u);
  });
});
