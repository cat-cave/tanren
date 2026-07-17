import { describe, expect, it } from "vitest";
import { DeployOnMergeWatcher } from "../src/engine/postMerge/deployOnMerge.js";
import { scriptedDeployTransport } from "./conformance/fakes/scriptedDeployTransport.js";
import { scriptedUrlProbe, instantVerifyPollPolicy } from "./conformance/fakes/scriptedUrlProbe.js";
import {
  deployOnMergePool as fakePool,
  deploySecrets as secrets,
  MERGE_SHA,
  ORG_ID,
  PRIOR_DEPLOYMENT_ID,
  RecordingDeployEventStore as RecordingEventStore,
  RUN_ID,
  runDeployOnMerge as run,
  VERCEL_APP_ID,
  VERCEL_GRANT,
  VERCEL_TARGET,
} from "./helpers/deployOnMergeHarness.js";
import { DeployOnMergeReleaseInstances } from "./helpers/deployOnMergeReleaseInstances.js";
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
    const releaseInstances = await run(
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
    await expect(
      releaseInstances.getByDeployment({
        orgId: ORG_ID,
        provider: "deploy.vercel",
        appId: VERCEL_APP_ID,
        deploymentId: "vercel_deploy_1",
      }),
    ).resolves.toMatchObject({ state: "live", environment: "production" });
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
    const releaseInstances = new DeployOnMergeReleaseInstances();
    const watcher = new DeployOnMergeWatcher({
      pool: fakePool({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT }),
      secrets: secrets(),
      transport,
      eventStore: events,
      urlProbe: scriptedUrlProbe(),
      verifyPoll: instantVerifyPollPolicy(),
      releaseInstances,
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
    await expect(
      releaseInstances.getByDeployment({
        orgId: ORG_ID,
        provider: "deploy.vercel",
        appId: VERCEL_APP_ID,
        deploymentId: "vercel_deploy_1",
      }),
    ).resolves.toMatchObject({ state: "built", environment: "preview" });
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
    const releaseInstances = new DeployOnMergeReleaseInstances();
    const watcher = new DeployOnMergeWatcher({
      pool: fakePool({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT }),
      secrets: secrets(),
      transport,
      eventStore: events,
      urlProbe: scriptedUrlProbe(),
      verifyPoll: instantVerifyPollPolicy(),
      releaseInstances,
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
    const releaseInstances = new DeployOnMergeReleaseInstances();
    const watcher = new DeployOnMergeWatcher({
      pool: fakePool({ merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT }),
      secrets: secrets(),
      transport,
      eventStore: events,
      urlProbe: scriptedUrlProbe(),
      verifyPoll: instantVerifyPollPolicy(),
      releaseInstances,
    });
    transport.scriptDeploymentStates("vercel_deploy_1", ["ERROR", "READY"]);
    await watcher.check(RUN_ID);
    expect(events.appends.find((a) => a.eventType === "deploy.verified")).toBeDefined();
    expect(events.appends.find((a) => a.eventType === "deploy.failed")).toBeUndefined();
    await expect(
      releaseInstances.getByDeployment({
        orgId: ORG_ID,
        provider: "deploy.vercel",
        appId: VERCEL_APP_ID,
        deploymentId: "vercel_deploy_1",
      }),
    ).resolves.toMatchObject({ state: "live", environment: "production" });
  });
  it("is a clean NO-OP for a project with no deploy config AND no deploy intent (no error, no deploy)", async () => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await run({ merged: true, config: {}, linkedGrants: [] }, transport, events);
    expect(transport.deploysTriggered()).toEqual([]);
    expect(events.appends).toEqual([]);
  });

  it.each([
    { provider_kind: "sentry", capabilities: ["errors"] },
    { provider_kind: "slack", capabilities: ["notifications"] },
  ])("treats an active $provider_kind non-deploy grant as a clean no-op", async (linkedGrant) => {
    const transport = scriptedDeployTransport("vercel");
    const events = new RecordingEventStore();
    await run({ merged: true, config: { version: 1 }, linkedGrants: [linkedGrant] }, transport, events);
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
    const releaseInstances = await run(
      { merged: true, config: VERCEL_TARGET, grant: VERCEL_GRANT, alreadyDeployed: true },
      transport,
      events,
    );
    expect(transport.deploysTriggered()).toEqual([]);
    expect(transport.statusPolls(PRIOR_DEPLOYMENT_ID)).toBeGreaterThan(0);
    const verified = events.appends.find((a) => a.eventType === "deploy.verified");
    expect(verified).toBeDefined();
    expect((verified!.payload as Record<string, unknown>)["deploymentId"]).toBe(PRIOR_DEPLOYMENT_ID);
    expect(events.appends.find((a) => a.eventType === "deploy.triggered")).toBeUndefined();
    await expect(
      releaseInstances.getByDeployment({
        orgId: ORG_ID,
        provider: "deploy.vercel",
        appId: VERCEL_APP_ID,
        deploymentId: PRIOR_DEPLOYMENT_ID,
      }),
    ).resolves.toMatchObject({ state: "live", environment: "production" });
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
