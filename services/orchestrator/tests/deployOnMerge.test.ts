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
  merged: boolean;
  config: Record<string, unknown>;
  grant?: { provider_kind: string; credential_ref: string; metadata: Record<string, unknown>; status?: string };
  /** The deploy-intent grant LIST (IntegrationConnectionsStore.list); [] = no deploy intent. */
  linkedGrants?: Array<{ provider_kind: string; capabilities?: string[]; credential_ref?: string }>;
  alreadyDeployed?: boolean;
  alreadyVerified?: boolean;
  alreadyFailed?: boolean;
  alreadySkipped?: boolean;
  noMergeSha?: boolean;
  appEnv?: Record<string, unknown>[];
}
function fakePool(state: PoolState): pg.Pool {
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (/event_type = 'merge\.completed'/u.test(sql)) {
      if (!state.merged) return { rows: [], rowCount: 0 };
      const payload = state.noMergeSha === true ? { prNumber: 7 } : { prNumber: 7, mergeSha: MERGE_SHA };
      return { rows: [{ payload }], rowCount: 1 };
    }
    if (/event_type IN \('deploy\.verified', 'deploy\.failed', 'deploy\.skipped'\)/u.test(sql)) {
      return state.alreadyVerified === true || state.alreadyFailed === true || state.alreadySkipped === true
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
    if (/SELECT connection_id, grant_id FROM project_integration_grant_selections/u.test(sql)) {
      const providerKind = params[2] as string;
      const selected = state.grant !== undefined && state.grant.provider_kind === providerKind;
      return selected
        ? { rows: [{ connection_id: "connection_0", grant_id: "grant_0" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM org_integration_connections c/u.test(sql) && /JOIN org_integration_grants g/u.test(sql)) {
      const grantsSource =
        state.grant === undefined
          ? (state.linkedGrants ?? []).map((grant) => ({
              ...grant,
              metadata: {},
              credential_ref: grant.credential_ref ?? "secret://org/x",
            }))
          : [state.grant];
      if (params.length > 2) {
        const rows = grantsSource.map((grant, index) => ({
          connection_id: `connection_${index}`,
          provider_kind: grant.provider_kind,
          provider_principal_id: `account_${index}`,
          display_name: `account_${index}`,
          principal_metadata: "metadata" in grant ? grant.metadata : {},
          connection_health: "healthy",
          connection_status: "active",
          current_auth_generation: 1,
          grant_id: `grant_${index}`,
          grant_current_generation: 1,
          grant_status: "active",
          plane: "control",
          environment: "control",
          credential_ref: (grant.credential_ref ?? "secret://org/x").includes("/g/")
            ? (grant.credential_ref ?? "secret://org/x")
            : `${grant.credential_ref ?? "secret://org/x"}/g/1`,
          auth_expires_at: null,
          auth_status: "active",
          capabilities: "capabilities" in grant ? (grant.capabilities ?? ["deploy"]) : ["deploy"],
          operations: ["discover", "provision", "bind", "teardown", "deploy"],
          provider_scopes: [],
          resource_constraints: {},
          policy_revision: "integration-catalog.v1",
          consent_revision: "consent.test",
          grant_expires_at: null,
          grant_generation_status: "active",
          selected_auth_generation: 1,
          selected_grant_generation: 1,
          selected_connection_id: `connection_${index}`,
          selected_grant_id: `grant_${index}`,
        }));
        return { rows, rowCount: rows.length };
      }
      const rows = grantsSource.map((grant, index) => ({
        connection_id: `connection_${index}`,
        grant_id: `grant_${index}`,
        org_id: ORG_ID,
        provider_kind: grant.provider_kind,
        provider_principal_id: `account_${index}`,
        principal_kind: "team",
        display_name: `account_${index}`,
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
        selected_for_project: false,
      }));
      return { rows, rowCount: rows.length };
    }
    if (/FROM project_app_env[\s\S]*WHERE org_id/u.test(sql)) {
      const rows = (state.appEnv ?? []).map((row, index) => ({
        id: `env_${index}`,
        org_id: ORG_ID,
        project_id: PROJECT_ID,
        environment: "production",
        binding_id: null,
        binding_generation: null,
        secret_generation: row["value_ref"] === null ? null : 1,
        description: "",
        ...row,
      }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}
class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: unknown; ambientOrgId?: string }> = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({ eventType: input.eventType, payload: input.payload, ambientOrgId: getJobOrgId() });
  }
}
function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: "secret://org/deploy-token", value: "deploy_token" });
  void store.put({ ref: "secret://org/deploy-token/g/1", value: "deploy_token" });
  void store.put({ ref: "secret://proj/resend", value: "re_live_secret" });
  return store;
}
const VERCEL_APP_ID = "vercel_app_1";
const VERCEL_TARGET = { version: 1, deployProvider: "deploy.vercel", deployAppId: VERCEL_APP_ID };
const VERCEL_GRANT = {
  provider_kind: "deploy.vercel",
  credential_ref: "secret://org/deploy-token",
  metadata: { teamId: "team_abc", slug: "acme" },
  status: "linked",
};
function githubGitSource(org: string, repo: string, sha: string): Record<string, string> {
  return { type: "github", org, repo, ref: sha, sha };
}
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
    urlProbe: scriptedUrlProbe(),
    verifyPoll: instantVerifyPollPolicy(),
  });
  await watcher.check(RUN_ID);
}
describe("DeployOnMergeWatcher (a deploy happened)", () => {
  it("triggers a real deploy of the merged ref + attaches runtime env + records deploy.triggered", async () => {
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
    const triggered = transport.deploysTriggered();
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.body["gitSource"]).toEqual(githubGitSource("acme", "widget", MERGE_SHA));
    expect(transport.envByApp()[VERCEL_APP_ID]).toEqual({ RESEND_API_KEY: "re_live_secret" });
    const log = transport.requestLog();
    expect(log.indexOf("set_env")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("set_env")).toBeLessThan(log.indexOf("deploy_trigger"));
    const deploy = events.appends.find((a) => a.eventType === "deploy.triggered");
    expect(deploy).toBeDefined();
    expect(deploy!.ambientOrgId).toBe(ORG_ID);
    const payload = deploy!.payload as Record<string, unknown>;
    expect(payload["provider"]).toBe("deploy.vercel");
    expect(payload["url"]).toMatch(/^https:\/\//u);
    expect(JSON.stringify(deploy)).not.toContain("re_live_secret");
    expect(payload["policyVersion"]).toBe(1);
    expect(payload["initiatingActor"]).toEqual({ kind: "service", id: "tanren-engine" });
    expect(payload["approvingActor"]).toBeUndefined();
    expect(payload["artifact"]).toEqual({ provenanceRef: `deploy.vercel:vercel_deploy_1@${MERGE_SHA}` });
    expect((payload["artifact"] as Record<string, unknown>)["checksum"]).toBeUndefined();
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
    expect(events.appends.find((a) => a.eventType === "deploy.skipped")).toBeUndefined();
  });
  it("fails LOUD on a provider ERROR terminal — escalates on non-convergence, not a count", async () => {
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
    });
    transport.scriptDeploymentStates("vercel_deploy_1", ["ERROR"]);
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/FAILURE state 'ERROR'/u);
    expect(events.appends.find((a) => a.eventType === "deploy.verified")).toBeUndefined();
    const failed = events.appends.find((a) => a.eventType === "deploy.failed");
    expect(failed).toBeDefined();
    expect(failed!.ambientOrgId).toBe(ORG_ID);
    const fPayload = failed!.payload as Record<string, unknown>;
    expect(typeof fPayload["attempts"]).toBe("number");
    expect(fPayload["attempts"] as number).toBeGreaterThanOrEqual(2);
    expect(fPayload["reason"]).toContain("did not reach a live deployment");
    expect(fPayload["reason"]).not.toMatch(/ERROR/u);
    expect(JSON.stringify(failed)).not.toContain("deploy_token");
  });
  it("records a DURABLE trigger-phase deploy.failed when an EXPECTED deploy throws before any trigger", async () => {
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
      egressPolicy: {
        allowsEgress: () => ({ allowed: true, reason: "test" }),
        allowsDeployTarget: () => ({ allowed: false, reason: "off-allowlist deploy target" }),
      },
    });
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/not .*allowed by the egress policy/u);
    expect(transport.deploysTriggered()).toEqual([]);
    expect(events.appends.find((a) => a.eventType === "deploy.verified")).toBeUndefined();
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
    });
    transport.scriptDeploymentStates("vercel_deploy_1", ["ERROR"]);
    await expect(watcher.check(RUN_ID)).rejects.toThrow(/FAILURE state 'ERROR'/u);
    const failures = events.appends.filter((a) => a.eventType === "deploy.failed");
    expect(failures).toHaveLength(1);
    expect((failures[0]!.payload as Record<string, unknown>)["phase"]).toBe("verify");
  });
  it("is TERMINAL on deploy.failed: a re-check after a prior failure is a no-op (no self-loop)", async () => {
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
  it.each([
    { label: "no_sha", state: { noMergeSha: true, config: VERCEL_TARGET, grant: VERCEL_GRANT } },
    {
      label: "config_incomplete",
      state: {
        config: { version: 1 } as Record<string, unknown>,
        linkedGrants: [{ provider_kind: "ci.something", capabilities: ["deploy"] }],
      },
    },
  ])("is TERMINAL on deploy.skipped: a re-check after a prior $label skip is a no-op", async ({ state }) => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await run({ merged: true, ...state, alreadySkipped: true }, transport, events);
    expect(events.appends).toEqual([]);
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
    });
    transport.scriptDeploymentStates("vercel_deploy_1", ["ERROR", "READY"]);
    await watcher.check(RUN_ID);
    expect(events.appends.find((a) => a.eventType === "deploy.verified")).toBeDefined();
    expect(events.appends.find((a) => a.eventType === "deploy.failed")).toBeUndefined();
  });
  it("is a clean NO-OP for a project with no deploy config AND no deploy intent (no error, no deploy)", async () => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await run({ merged: true, config: {}, linkedGrants: [] }, transport, events);
    expect(transport.deploysTriggered()).toEqual([]);
    expect(events.appends).toEqual([]);
  });
  it("fails LOUD when a deploy IS expected (a deploy integration is linked) but the config is INCOMPLETE", async () => {
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
    expectSkipped(events, "config_incomplete", "no complete deploy target");
    expect(events.appends.find((a) => a.eventType === "deploy.triggered")).toBeUndefined();
  });
  it("fails LOUD on an INCOMPLETE config when the deploy intent comes from a deploy PROVIDER grant kind", async () => {
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
    const transport = scriptedDeployTransport("vercel", []);
    await transport.request({
      method: "POST",
      url: "https://api.vercel.com/v9/projects",
      headers: {},
      body: { name: "acme-widget" },
    });
    const events = new RecordingEventStore();
    await run({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT, alreadyDeployed: true }, transport, events);
    expect(transport.deploysTriggered()).toEqual([]);
    expect(transport.statusPolls(PRIOR_DEPLOYMENT_ID)).toBeGreaterThan(0);
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
    expectSkipped(events, "merge_sha_missing", "no mergeSha");
  });
  it("fails LOUD when the project configures a deploy but the org has no matching grant", async () => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await expect(run({ merged: true, config: VERCEL_TARGET }, transport, events)).rejects.toThrow(/no matching grant/u);
  });
});
