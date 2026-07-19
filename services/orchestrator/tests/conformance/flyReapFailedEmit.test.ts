// apex-v96 guard (part 1): a SWALLOWED single-instance machine reap must not silently
// accumulate machines — a non-converged reap emits a durable, LOUD `deploy.reap_failed`
// (warn), while the deploy itself STILL succeeds (reap is best-effort, non-fatal).
//
// Without this signal, accumulated Fly machines fragment a single-instance product's
// file store, presenting as a false "persistence broken" PRODUCT symptom whose real
// cause is INFRA — the exact apex-v96 misattribution this event prevents.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { DeployRef, ReleaseInstanceRecord } from "../../src/engine/contracts/deployAdapter.js";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { projectIntegrationOperationTarget } from "../../src/engine/contracts/integrationAuthority.js";
import { DirectApiDeployAdapter } from "../../src/engine/deploy/directApiDeployAdapter.js";
import { EventReapFailureReporter } from "../../src/engine/deploy/reapFailureReporter.js";
import { releaseInstancesStub } from "../helpers/releaseInstancesStub.js";
import { FakeEventStore } from "../helpers/fakeEventStore.js";
import { instantVerifyPollPolicy, scriptedUrlProbe } from "./fakes/scriptedUrlProbe.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
import { testOrgGrant } from "../helpers/orgGrant.js";

const TOKEN_REF = "secret://org/fly-token";
const APP_NAME = "tanren-acme-web";
const CONTEXT: ProjectContext = {
  projectId: "proj_acme-web",
  orgId: "org_1",
  orgSlug: "tanren",
  stack: "node",
  name: "acme-web",
};
const SOURCE = { repo: "acme/acme-web", ref: "main" };
const METADATA = { orgSlug: "acme", image: "registry.fly.io/acme-web:deployment-1" };

async function store(): Promise<InMemorySecretStore> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: TOKEN_REF, value: "fly_deploy_test_token" });
  await secrets.put({ ref: `${TOKEN_REF}/g/1`, value: "fly_deploy_test_token" });
  return secrets;
}

function grantFor(operation: "provision" | "deploy" | "verify", target: Record<string, unknown>) {
  return testOrgGrant({
    providerKind: "deploy.flyio",
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata: METADATA,
    capability: "deploy",
    operation,
    target,
    orgId: CONTEXT.orgId,
    projectId: CONTEXT.projectId,
  });
}

async function deployFly(adapter: DirectApiDeployAdapter): Promise<{ ref: DeployRef; deploymentId: string }> {
  const artifact = await adapter.provisionOrBind(
    await grantFor("provision", projectIntegrationOperationTarget(CONTEXT)),
    CONTEXT,
    { mode: "provision" },
  );
  const ref: DeployRef = { provider: "deploy.flyio", appId: artifact.deployRef!.appId };
  const deployed = await adapter.deploy(
    await grantFor("deploy", { resourceId: ref.appId, sourceRepo: SOURCE.repo, sourceRef: SOURCE.ref }),
    ref,
    SOURCE,
  );
  return { ref, deploymentId: deployed.deploymentId };
}

describe("deploy.reap_failed on a swallowed post-verify machine reap", () => {
  it("emits deploy.reap_failed (warn) yet still verifies the deploy when a prior-machine DELETE fails", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.seedMachines(APP_NAME, ["m_prior"]);
    // The prior machine's reap DELETE rejects — the accumulation blip the sweeper guards.
    transport.throwOnMachineDelete("m_prior");
    const releases = releaseInstancesStub();
    releases.markLive = async () => ({}) as ReleaseInstanceRecord;
    const events = new FakeEventStore();
    const adapter = new DirectApiDeployAdapter({
      provisioner: { transport, secrets: await store(), allowFlyStaticDeploy: true },
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
      releaseInstances: releases,
      reapFailureReporter: new EventReapFailureReporter(events),
    });
    const { ref, deploymentId } = await deployFly(adapter);
    transport.scriptDeploymentStates(deploymentId, ["started"]);

    // The deploy STILL verifies live — the reap failure is non-fatal.
    await expect(
      adapter.verify(() => grantFor("verify", { resourceId: ref.appId, deploymentId }), ref, deploymentId),
    ).resolves.toMatchObject({
      ready: true,
    });

    // ...but the swallowed reap is now LOUD + durable.
    const reapFailed = events.events.filter((event) => event.eventType === "deploy.reap_failed");
    expect(reapFailed).toHaveLength(1);
    const recorded = reapFailed[0]!;
    expect(recorded.orgId).toBe(CONTEXT.orgId);
    expect(recorded.projectId).toBe(CONTEXT.projectId);
    expect(recorded.payload).toMatchObject({
      provider: "deploy.flyio",
      appId: ref.appId,
      deploymentId,
      source: "verify",
      listFailed: false,
      failedMachineCount: 1,
      reapedMachineCount: 0,
    });
    // The stale machine survived the blip (it will be reaped on the next reconciler sweep).
    expect(transport.machineIdsFor(APP_NAME).sort()).toEqual(["m_prior", deploymentId].sort());
  });

  it("emits nothing on a clean reap (the prior machine is reaped, deploy verified)", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.seedMachines(APP_NAME, ["m_prior"]);
    const releases = releaseInstancesStub();
    releases.markLive = async () => ({}) as ReleaseInstanceRecord;
    const events = new FakeEventStore();
    const adapter = new DirectApiDeployAdapter({
      provisioner: { transport, secrets: await store(), allowFlyStaticDeploy: true },
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
      releaseInstances: releases,
      reapFailureReporter: new EventReapFailureReporter(events),
    });
    const { ref, deploymentId } = await deployFly(adapter);
    transport.scriptDeploymentStates(deploymentId, ["started"]);

    await expect(
      adapter.verify(() => grantFor("verify", { resourceId: ref.appId, deploymentId }), ref, deploymentId),
    ).resolves.toMatchObject({
      ready: true,
    });

    expect(events.events.filter((event) => event.eventType === "deploy.reap_failed")).toHaveLength(0);
    expect(transport.machineIdsFor(APP_NAME)).toEqual([deploymentId]);
  });
});
