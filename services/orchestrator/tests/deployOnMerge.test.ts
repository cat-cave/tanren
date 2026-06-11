// Deploy-on-merge ("a deploy happened") coverage: a merged run attaches the runtime app
// env BEFORE it TRIGGERS a real deploy of the merged ref (env-before-trigger ordering
// asserted); no-config + no-intent is a clean no-op; a PRE-resolution failure (incomplete
// config / no mergeSha) records a DURABLE `deploy.skipped` BEFORE failing LOUD (never a
// console-only swallow); a re-check is idempotent; a missing grant fails LOUD. Driven over
// a fake pool + the scripted deploy transport — no Postgres, no real provider.

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
  grant?: { provider_kind: string; credential_ref: string; metadata: Record<string, unknown>; status?: string };
  /**
   * The org's `org_integrations` grant LIST the deploy-intent probe reads
   * (loadDeployTarget → OrgIntegrationsStore.list). Used to distinguish a legitimate
   * "no deploy configured" no-op from an "incomplete deploy config when a deploy was
   * expected" loud failure. Defaults to [] (no deploy intent).
   */
  linkedGrants?: Array<{ provider_kind: string; capabilities?: string[]; credential_ref?: string }>;
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
    if (/FROM org_integrations WHERE org_id = \$1 ORDER BY provider_kind/u.test(sql)) {
      // The deploy-intent probe (OrgIntegrationsStore.list): map domain rows to row shape.
      const rows = (state.linkedGrants ?? []).map((g, i) => ({
        id: `int_${i}`,
        org_id: ORG_ID,
        provider_kind: g.provider_kind,
        credential_ref: g.credential_ref ?? "secret://org/x",
        metadata: {},
        capabilities: g.capabilities ?? [],
        status: "linked",
      }));
      return { rows, rowCount: rows.length };
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
// `version: 1` mirrors a real persisted project config — the deploy watcher parses it
// through the strict migrator for the governance policy version (a missing version is a LOUD prod error).
const VERCEL_TARGET = { version: 1, deployProvider: "deploy.vercel", deployAppId: VERCEL_APP_ID };
const VERCEL_GRANT = {
  provider_kind: "deploy.vercel",
  credential_ref: "secret://org/deploy-token",
  metadata: { teamId: "team_abc", slug: "acme" },
  // `status` (+ app_env `source`) are NOT NULL on the real rows — the fakes carry them so the seam decode passes.
  status: "linked",
};

// The REAL v13 github gitSource shape: org (owner) + bare repo + the commit in `sha`
// (and `ref`, which accepts a SHA) — the shape Vercel's deployments API requires.
function githubGitSource(org: string, repo: string, sha: string): Record<string, string> {
  return { type: "github", org, repo, ref: sha, sha };
}

// Assert a DURABLE org-scoped `deploy.skipped` with the given reason + detail substring
// was recorded (the pre-resolution-failure record, not a console-only swallow).
function expectSkipped(events: RecordingEventStore, reason: string, detailSubstr: string): void {
  const skipped = events.appends.find((a) => a.eventType === "deploy.skipped");
  expect(skipped).toBeDefined();
  expect(skipped!.ambientOrgId).toBe(ORG_ID);
  const sPayload = skipped!.payload as Record<string, unknown>;
  expect(sPayload["reason"]).toBe(reason);
  expect(sPayload["detail"]).toContain(detailSubstr);
}

async function run(state: PoolState, transport: ScriptedDeployTransport, events: RecordingEventStore): Promise<void> {
  const watcher = new DeployOnMergeWatcher({
    pool: fakePool(state),
    secrets: secrets(),
    transport,
    eventStore: events,
    // Scripted smoke probe + instant poll so verify runs over the scripted transport (no
    // network / no real timers); the transport reports READY by default (polls once, 200).
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
            key: "RESEND_API_KEY",
            value_ref: "secret://proj/resend",
            plain_value: null,
            scopes: ["runtime"],
            source: "byo",
          },
        ],
      },
      transport,
      events,
    );

    // A real deploy fired with the merged ref in the REAL v13 github gitSource shape: org
    // (owner) + bare repo + the merged COMMIT SHA (in sha), not the (deleted) PR branch.
    const triggered = transport.deploysTriggered();
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.body["gitSource"]).toEqual(githubGitSource("acme", "widget", MERGE_SHA));
    expect(transport.envByApp()[VERCEL_APP_ID]).toEqual({ RESEND_API_KEY: "re_live_secret" });
    // ENV BEFORE TRIGGER: `set_env` was attached BEFORE `deploy_trigger`, so the released
    // deployment actually carries its secrets (the leading `create` seeded the app).
    const log = transport.requestLog();
    expect(log.indexOf("set_env")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("set_env")).toBeLessThan(log.indexOf("deploy_trigger"));
    // deploy.triggered recorded under the org scope, with a resolved URL (no secret).
    const deploy = events.appends.find((a) => a.eventType === "deploy.triggered");
    expect(deploy).toBeDefined();
    expect(deploy!.ambientOrgId).toBe(ORG_ID);
    const payload = deploy!.payload as Record<string, unknown>;
    expect(payload["provider"]).toBe("deploy.vercel");
    expect(payload["url"]).toMatch(/^https:\/\//u);
    expect(JSON.stringify(deploy)).not.toContain("re_live_secret");
    // AUDIT-EVIDENCE BASELINE: policy version + initiating actor (the autonomous service,
    // no approver) + a NON-SECRET artifact provenance ref (no checksum here).
    expect(payload["policyVersion"]).toBe(1);
    expect(payload["initiatingActor"]).toEqual({ kind: "service", id: "tanren-engine" });
    expect(payload["approvingActor"]).toBeUndefined();
    expect(payload["artifact"]).toEqual({ provenanceRef: `deploy.vercel:vercel_deploy_1@${MERGE_SHA}` });
    expect((payload["artifact"] as Record<string, unknown>)["checksum"]).toBeUndefined();

    // The deploy is PROVEN, not fire-and-forget: verify polled to READY + smoked the URL,
    // recording deploy.verified (provider + url + state + smoke status).
    const verified = events.appends.find((a) => a.eventType === "deploy.verified");
    expect(verified).toBeDefined();
    expect(verified!.ambientOrgId).toBe(ORG_ID);
    const vPayload = verified!.payload as Record<string, unknown>;
    expect(vPayload["provider"]).toBe("deploy.vercel");
    expect(vPayload["state"]).toBe("READY");
    expect(vPayload["smokeStatus"]).toBe(200);
    expect(vPayload["url"]).toMatch(/^https:\/\//u);
    expect(JSON.stringify(verified)).not.toContain("deploy_token");
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
    // The deployment reports ERROR on every attempt — verify exhausts its bounded retry,
    // escalates LOUD (deploy.failed), re-throws. No deploy.verified.
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

  it("records a DURABLE trigger-phase deploy.failed when an EXPECTED deploy throws before any trigger", async () => {
    // A deploy is EXPECTED (a target resolved) but throws BEFORE the verify retry — here a
    // denied egress target. It must append a LOUD `deploy.failed` (phase=trigger, no
    // deploymentId/attempts) before re-throwing, not swallow the throw as a log line.
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
      // A restrictive policy that DENIES the target — a trigger-phase failure (the deploy
      // never fires) that the watcher must record durably, not swallow.
      egressPolicy: {
        allowsEgress: () => ({ allowed: true, reason: "test" }),
        allowsDeployTarget: () => ({ allowed: false, reason: "off-allowlist deploy target" }),
      },
    });
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/not .*allowed by the egress policy/u);
    // No deploy fired (the target was denied) and the deploy was NEVER proven live.
    expect(transport.deploysTriggered()).toEqual([]);
    expect(events.appends.find((a) => a.eventType === "deploy.verified")).toBeUndefined();
    // The LOUD + DURABLE record: an org-scoped trigger-phase deploy.failed, fixed reason,
    // NO deploymentId/attempts (no deployment ever existed).
    const failed = events.appends.find((a) => a.eventType === "deploy.failed");
    expect(failed).toBeDefined();
    expect(failed!.ambientOrgId).toBe(ORG_ID);
    const fPayload = failed!.payload as Record<string, unknown>;
    expect(fPayload["phase"]).toBe("trigger");
    expect(fPayload["deploymentId"]).toBeUndefined();
    expect(fPayload["attempts"]).toBeUndefined();
    expect(fPayload["reason"]).toContain("could not be triggered or attached");
    expect(fPayload["provider"]).toBe("deploy.vercel");
  });

  it("does NOT double-record on a verify-phase failure (only the verify-phase deploy.failed)", async () => {
    // A verify exhaustion records its OWN verify-phase deploy.failed before re-throwing;
    // the outer trigger-phase guard must NOT add a second one for the same throw.
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
    transport.scriptDeploymentStates("vercel_deploy_1", ["ERROR"]);
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/FAILURE state 'ERROR'/u);
    const failures = events.appends.filter((a) => a.eventType === "deploy.failed");
    expect(failures).toHaveLength(1);
    expect((failures[0]!.payload as Record<string, unknown>)["phase"]).toBe("verify");
  });

  it("is TERMINAL on deploy.failed: a re-check after a prior failure is a no-op (no self-loop)", async () => {
    // deploy.failed is run-scoped (its append wakes the subscriber), so a prior one must
    // gate check() to a no-op — never re-verify nor append a second deploy.failed.
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
    // Attempt 1 reads ERROR (transient → throws); the retry's attempt 2 reads READY → the
    // deploy is proven live. No deploy.failed escalation.
    transport.scriptDeploymentStates("vercel_deploy_1", ["ERROR", "READY"]);
    await watcher.check(RUN_ID);
    expect(events.appends.find((a) => a.eventType === "deploy.verified")).toBeDefined();
    expect(events.appends.find((a) => a.eventType === "deploy.failed")).toBeUndefined();
  });

  it("is a clean NO-OP for a project with no deploy config AND no deploy intent (no error, no deploy)", async () => {
    // No deployProvider/deployAppId AND the org links NO deploy-capable integration ⇒
    // a LEGITIMATE no-op (most projects have no deploy target). Logged, never an error.
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await run({ merged: true, config: {}, linkedGrants: [] }, transport, events);
    expect(transport.deploysTriggered()).toEqual([]);
    expect(events.appends).toEqual([]);
  });

  it("fails LOUD when a deploy IS expected (a deploy integration is linked) but the config is INCOMPLETE", async () => {
    // The org links a deploy-capable integration (deploy is EXPECTED) but the project
    // config carries no complete deploy target. For apex (which proves a live URL) this
    // must NEVER silently skip and make the run look "done" without a deployment — it is
    // a LOUD fail-closed misconfiguration. Probed via a grant whose CAPABILITY is deploy.
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await expect(
      run(
        {
          merged: true,
          config: { version: 1 },
          linkedGrants: [{ provider_kind: "ci.something", capabilities: ["deploy"] }],
        },
        transport,
        events,
      ),
    ).rejects.toThrow(/links a deploy integration .*no complete deploy target/u);
    expect(transport.deploysTriggered()).toEqual([]);
    // DURABLE pre-resolution failure recorded BEFORE the loud throw (not a console swallow).
    expectSkipped(events, "config_incomplete", "no complete deploy target");
    expect(events.appends.find((a) => a.eventType === "deploy.triggered")).toBeUndefined();
  });

  it("fails LOUD on an INCOMPLETE config when the deploy intent comes from a deploy PROVIDER grant kind", async () => {
    // Deploy intent is also signalled by a grant whose provider_kind IS a deploy
    // provider (deploy.vercel/deploy.flyio), even with no explicit `deploy` capability.
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await expect(
      run(
        {
          merged: true,
          config: { version: 1, deployProvider: "deploy.vercel" },
          linkedGrants: [{ provider_kind: "deploy.vercel" }],
        },
        transport,
        events,
      ),
    ).rejects.toThrow(/missing deployAppId/u);
    expect(transport.deploysTriggered()).toEqual([]);
    // The same durable pre-resolution record (config_incomplete) before the loud throw.
    expectSkipped(events, "config_incomplete", "no complete deploy target");
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
    // A transient verify failure left `deploy.triggered` but no `deploy.verified`. The
    // re-check must NOT re-deploy; it re-verifies the SAME deployment (prior deploymentId)
    // and records deploy.verified — the fix for a transient failure dead-ending the deploy.
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
    // DURABLE pre-resolution failure recorded BEFORE the loud throw (not a console swallow).
    expectSkipped(events, "merge_sha_missing", "no mergeSha");
  });

  it("fails LOUD when the project configures a deploy but the org has no matching grant", async () => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await expect(run({ merged: true, config: VERCEL_TARGET }, transport, events)).rejects.toThrow(/no matching grant/u);
  });
});
