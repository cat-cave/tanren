// apex-v96 guard (part 2): the durable, out-of-band Fly-machine orphan reconciler
// reaps accumulated stale machines the inline post-verify reap missed — keeping ONLY
// the release_instances-recorded live machine per single-instance app. It is
// idempotent (a converged app reaps nothing) and progress/sign-of-life based (no
// wall-clock deadline): a transient list/delete blip during one sweep is retried on
// the NEXT sweep, never silently swallowed.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { OrgGrant } from "../src/engine/contracts/integrationProvisioner.js";
import type { DeployHttpTransport } from "../src/engine/provisioners/deployTransport.js";
import { deployProvisionerFor } from "../src/engine/workflow/deployProvisionerFor.js";
import { EventReapFailureReporter } from "../src/engine/deploy/reapFailureReporter.js";
import { FlyMachineOrphanSweeper, type LiveFlyDeployment } from "../src/engine/provisioners/flyMachineOrphanSweeper.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { testOrgGrant } from "./helpers/orgGrant.js";
import { scriptedDeployTransport, type ScriptedDeployTransport } from "./conformance/fakes/scriptedDeployTransport.js";

const TOKEN_REF = "secret://org/fly-token";
const APP_NAME = "tanren-acme-web";
// The scripted transport assigns the first seeded app the deterministic id `fly_app_1`
// (its internal counter). The reap looks the app up by this appId (appAccess.listApps).
const APP_ID = "fly_app_1";
const LIVE_MACHINE = "m_live";
const ORG_ID = "org_1";
const PROJECT_ID = "proj_acme-web";

const LIVE_DEPLOYMENT: LiveFlyDeployment = {
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  appId: APP_ID,
  deploymentId: LIVE_MACHINE,
};

async function secretStore(): Promise<InMemorySecretStore> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: TOKEN_REF, value: "fly_deploy_test_token" });
  await secrets.put({ ref: `${TOKEN_REF}/g/1`, value: "fly_deploy_test_token" });
  return secrets;
}

function verifyGrant(): Promise<OrgGrant> {
  return testOrgGrant({
    providerKind: "deploy.flyio",
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata: { orgSlug: "acme", image: "registry.fly.io/acme-web:x" },
    capability: "deploy",
    operation: "verify",
    target: { resourceId: APP_ID, deploymentId: LIVE_MACHINE },
    orgId: ORG_ID,
    projectId: PROJECT_ID,
  });
}

async function buildSweeper(
  transport: DeployHttpTransport,
  events: FakeEventStore,
  live: LiveFlyDeployment[] = [LIVE_DEPLOYMENT],
): Promise<FlyMachineOrphanSweeper> {
  const provisioner = deployProvisionerFor("deploy.flyio", { transport, secrets: await secretStore() });
  return new FlyMachineOrphanSweeper({
    liveDeployments: { list: async () => live },
    grants: { resolve: async () => verifyGrant() },
    provisioner,
    reporter: new EventReapFailureReporter(events),
  });
}

// A machines-LIST that fails ONCE (a transient blip), then delegates — models "the blip
// cleared on the next sweep" against the SAME underlying state.
function blipOnceListTransport(inner: ScriptedDeployTransport): DeployHttpTransport {
  let listCalls = 0;
  return {
    async request(req) {
      const path = req.url.split("?")[0] ?? "";
      if (req.method === "GET" && /\/v1\/apps\/[^/]+\/machines$/u.test(path)) {
        listCalls += 1;
        if (listCalls === 1) {
          return { status: 503, ok: false, json: undefined, text: "blip" };
        }
      }
      return inner.request(req);
    },
  };
}

describe("FlyMachineOrphanSweeper", () => {
  it("reaps every stale machine, keeps the live one, and is idempotent on the next sweep", async () => {
    const transport = scriptedDeployTransport("fly", [APP_NAME]);
    transport.seedMachines(APP_NAME, [LIVE_MACHINE, "m_stale1", "m_stale2"]);
    const events = new FakeEventStore();
    const sweeper = await buildSweeper(transport, events);

    const first = await sweeper.tick();
    expect(first.reconciled).toBe(1);
    expect(first.reapedMachineIds.sort()).toEqual(["m_stale1", "m_stale2"]);
    expect(first.reapFailures).toBe(0);
    expect(transport.machineIdsFor(APP_NAME)).toEqual([LIVE_MACHINE]);
    expect(events.events.filter((event) => event.eventType === "deploy.reap_failed")).toHaveLength(0);

    // A second sweep over the converged app reaps nothing new (idempotent).
    const second = await sweeper.tick();
    expect(second.reapedMachineIds).toEqual([]);
    expect(second.reapFailures).toBe(0);
    expect(transport.machineIdsFor(APP_NAME)).toEqual([LIVE_MACHINE]);
  });

  it("retries a transient list blip on the next sweep instead of swallowing it silently", async () => {
    const inner = scriptedDeployTransport("fly", [APP_NAME]);
    inner.seedMachines(APP_NAME, [LIVE_MACHINE, "m_stale1"]);
    const events = new FakeEventStore();
    const sweeper = await buildSweeper(blipOnceListTransport(inner), events);

    // Sweep 1: the machines LIST blips → nothing reaped, but the failure is LOUD + durable.
    const first = await sweeper.tick();
    expect(first.reapedMachineIds).toEqual([]);
    expect(first.reapFailures).toBe(1);
    expect(inner.machineIdsFor(APP_NAME).sort()).toEqual([LIVE_MACHINE, "m_stale1"].sort());
    const reapFailed = events.events.filter((event) => event.eventType === "deploy.reap_failed");
    expect(reapFailed).toHaveLength(1);
    expect(reapFailed[0]!.orgId).toBe(ORG_ID);
    expect(reapFailed[0]!.payload).toMatchObject({ source: "sweeper", listFailed: true, appId: APP_ID });

    // Sweep 2: the blip cleared → the stale machine is reaped, the live one kept.
    const second = await sweeper.tick();
    expect(second.reapedMachineIds).toEqual(["m_stale1"]);
    expect(inner.machineIdsFor(APP_NAME)).toEqual([LIVE_MACHINE]);
  });

  it("skips a deployment whose grant cannot be resolved (never throws, never reaps)", async () => {
    const transport = scriptedDeployTransport("fly", [APP_NAME]);
    transport.seedMachines(APP_NAME, [LIVE_MACHINE, "m_stale1"]);
    const events = new FakeEventStore();
    const provisioner = deployProvisionerFor("deploy.flyio", { transport, secrets: await secretStore() });
    const sweeper = new FlyMachineOrphanSweeper({
      liveDeployments: { list: async () => [LIVE_DEPLOYMENT] },
      grants: { resolve: async (): Promise<OrgGrant | undefined> => undefined },
      provisioner,
      reporter: new EventReapFailureReporter(events),
    });

    const summary = await sweeper.tick();
    expect(summary.reapedMachineIds).toEqual([]);
    expect(summary.reapFailures).toBe(0);
    // No grant ⇒ no reap attempted; the machines are untouched.
    expect(transport.machineIdsFor(APP_NAME).sort()).toEqual([LIVE_MACHINE, "m_stale1"].sort());
  });
});
