// Fly machine cleanup must wait for the DirectApiDeployAdapter verification seam:
// destroying the old machine immediately after POST /machines creates an outage when
// the new image fails before it can serve the app's stable hostname.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { DeployRef, ReleaseInstanceRecord } from "../../src/engine/contracts/deployAdapter.js";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { projectIntegrationOperationTarget } from "../../src/engine/contracts/integrationAuthority.js";
import { DirectApiDeployAdapter } from "../../src/engine/deploy/directApiDeployAdapter.js";
import { releaseInstancesStub } from "../helpers/releaseInstancesStub.js";
import { instantVerifyPollPolicy, scriptedUrlProbe } from "./fakes/scriptedUrlProbe.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
import { testOrgGrant } from "../helpers/orgGrant.js";

const TOKEN_REF = "secret://org/fly-token";
const TOKEN_VALUE = "fly_deploy_test_token";
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
  await secrets.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  await secrets.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  return secrets;
}

async function provisionGrant() {
  return testOrgGrant({
    providerKind: "deploy.flyio",
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata: METADATA,
    capability: "deploy",
    operation: "provision",
    target: projectIntegrationOperationTarget(CONTEXT),
    orgId: CONTEXT.orgId,
    projectId: CONTEXT.projectId,
  });
}

async function deployGrant(ref: DeployRef) {
  return testOrgGrant({
    providerKind: "deploy.flyio",
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata: METADATA,
    capability: "deploy",
    operation: "deploy",
    target: { resourceId: ref.appId, sourceRepo: SOURCE.repo, sourceRef: SOURCE.ref },
    orgId: CONTEXT.orgId,
    projectId: CONTEXT.projectId,
  });
}

async function verifyGrant(ref: DeployRef, deploymentId: string) {
  return testOrgGrant({
    providerKind: "deploy.flyio",
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata: METADATA,
    capability: "deploy",
    operation: "verify",
    target: { resourceId: ref.appId, deploymentId },
    orgId: CONTEXT.orgId,
    projectId: CONTEXT.projectId,
  });
}

async function deployFly(adapter: DirectApiDeployAdapter): Promise<{ ref: DeployRef; deploymentId: string }> {
  const artifact = await adapter.provisionOrBind(await provisionGrant(), CONTEXT, { mode: "provision" });
  const ref: DeployRef = { provider: "deploy.flyio", appId: artifact.deployRef!.appId };
  const deployed = await adapter.deploy(await deployGrant(ref), ref, SOURCE);
  return { ref, deploymentId: deployed.deploymentId };
}

describe("Fly machine reap after verification", () => {
  it("keeps the prior machine serving when the new machine fails its health poll", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.seedMachines(APP_NAME, ["m_prior"]);
    const releases = releaseInstancesStub();
    let markLiveCalls = 0;
    releases.markLive = async () => {
      markLiveCalls += 1;
      return {} as ReleaseInstanceRecord;
    };
    const adapter = new DirectApiDeployAdapter({
      provisioner: { transport, secrets: await store(), allowFlyStaticDeploy: true },
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
      releaseInstances: releases,
    });
    const { ref, deploymentId } = await deployFly(adapter);
    transport.scriptDeploymentStates(deploymentId, ["failed"]);

    await expect(adapter.verify(() => verifyGrant(ref, deploymentId), ref, deploymentId)).rejects.toThrow(
      /FAILURE state 'failed'/u,
    );

    expect(markLiveCalls).toBe(0);
    expect(transport.machinesDeleted()).toEqual([]);
    expect(transport.machineIdsFor(APP_NAME).sort()).toEqual(["m_prior", deploymentId].sort());
  });

  it("reaps the prior machine only after markLive succeeds for a healthy new machine", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.seedMachines(APP_NAME, ["m_prior"]);
    const releases = releaseInstancesStub();
    let markLiveCalls = 0;
    releases.markLive = async () => {
      markLiveCalls += 1;
      expect(transport.machinesDeleted()).toEqual([]);
      return {} as ReleaseInstanceRecord;
    };
    const adapter = new DirectApiDeployAdapter({
      provisioner: { transport, secrets: await store(), allowFlyStaticDeploy: true },
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
      releaseInstances: releases,
    });
    const { ref, deploymentId } = await deployFly(adapter);
    transport.scriptDeploymentStates(deploymentId, ["started"]);

    await expect(adapter.verify(() => verifyGrant(ref, deploymentId), ref, deploymentId)).resolves.toMatchObject({
      ready: true,
    });

    expect(markLiveCalls).toBe(1);
    expect(transport.machinesDeleted()).toEqual([{ appName: APP_NAME, machineId: "m_prior", force: true }]);
    expect(transport.machineIdsFor(APP_NAME)).toEqual([deploymentId]);
  });
});
