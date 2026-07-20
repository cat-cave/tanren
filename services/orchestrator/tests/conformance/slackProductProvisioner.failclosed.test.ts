// Fail-closed negative controls for the direct PRODUCT Slack implementation.
// These exercise the real provisioner with a scripted protocol transport; no
// tests-only class is reachable from production construction.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { generationSecretRef } from "../../src/engine/contracts/integrationSecretStore.js";
import { projectIntegrationOperationTarget } from "../../src/engine/contracts/integrationAuthority.js";
import {
  goldenCrossPlaneForbiddenRequirement,
  goldenProductMessagingRequirement,
  type IntegrationRequirementV1,
} from "../../src/engine/contracts/integrationRequirement.js";
import { ProductProvisionFailedError } from "../../src/engine/contracts/applicationIntegrationProvisioner.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FetchSlackProductTransport } from "../../src/engine/integrations/product/fetchSlackProductTransport.js";
import {
  SlackProductProvisioner,
  type SlackProductTransportFactory,
} from "../../src/engine/integrations/product/slackProductProvisioner.js";
import { testOrgGrant } from "../helpers/orgGrant.js";
import { ScriptedSlackProductTransport } from "./fakes/scriptedSlackProductTransport.js";

const TOKEN_BASE = "secret://org/direct-failclosed-slack-token";
const TOKEN = "xoxb-direct-failclosed-token";
const ctx = (projectId: string): ProjectContext => ({
  orgId: "org_direct",
  projectId,
  orgSlug: "direct-org",
  stack: "node",
  name: projectId,
});

function directRequirement(): IntegrationRequirementV1 {
  return {
    ...goldenProductMessagingRequirement(),
    requiredScopes: ["chat:write", "channels:read", "channels:manage", "channels:join", "channels:history"],
    bindingOutputs: [
      {
        version: 1,
        kind: "product.messaging.bot_token_ref",
        logicalKey: "SLACK_BOT_TOKEN",
        classification: "secret_ref",
        required: true,
      },
      {
        version: 1,
        kind: "product.messaging.channel_id",
        logicalKey: "SLACK_CHANNEL_ID",
        classification: "plain",
        required: true,
      },
    ],
  };
}

async function directGrant(projectCtx: ProjectContext): Promise<OrgGrant> {
  return testOrgGrant({
    providerKind: "slack",
    capability: "messaging.send",
    operation: "provision",
    target: projectIntegrationOperationTarget(projectCtx),
    credentialRef: generationSecretRef(TOKEN_BASE, 1),
    metadata: { workspaceId: "T_DIRECT" },
    orgId: projectCtx.orgId,
    projectId: projectCtx.projectId,
  });
}

async function directSecrets(value = TOKEN): Promise<InMemorySecretStore> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: generationSecretRef(TOKEN_BASE, 1), value });
  return secrets;
}

function provisioner(factory: SlackProductTransportFactory, secrets: InMemorySecretStore): SlackProductProvisioner {
  return new SlackProductProvisioner(factory, secrets);
}

describe("SlackProductProvisioner fail-closed", () => {
  it("blocks before any Slack call when the product bot token is missing", async () => {
    const projectCtx = ctx("missing_token");
    let transportConstructed = 0;
    const direct = provisioner(() => {
      transportConstructed += 1;
      return new ScriptedSlackProductTransport();
    }, new InMemorySecretStore());
    const plan = direct.plan(directRequirement(), projectCtx);

    await expect(direct.provision(await directGrant(projectCtx), plan, projectCtx)).rejects.toThrow(
      /direct_slack_bot_token_unresolved/u,
    );
    expect(transportConstructed).toBe(0);
  });

  it("blocks before any Slack call when the product bot token is blank", async () => {
    const projectCtx = ctx("blank_token");
    let transportConstructed = 0;
    const direct = provisioner(
      () => {
        transportConstructed += 1;
        return new ScriptedSlackProductTransport();
      },
      await directSecrets(" \t "),
    );
    const plan = direct.plan(directRequirement(), projectCtx);

    await expect(direct.provision(await directGrant(projectCtx), plan, projectCtx)).rejects.toThrow(
      ProductProvisionFailedError,
    );
    expect(transportConstructed).toBe(0);
  });

  it("blocks incomplete blank channel evidence before it can create or post a message", async () => {
    const projectCtx = ctx("blank_evidence");
    const transport = new ScriptedSlackProductTransport({
      channels: [{ id: "", name: "", isMember: true }],
    });
    const direct = provisioner(() => transport, await directSecrets());
    const plan = direct.plan(directRequirement(), projectCtx);

    await expect(direct.provision(await directGrant(projectCtx), plan, projectCtx)).rejects.toThrow(
      /incomplete_slack_evidence/u,
    );
    expect(transport.createCount).toBe(0);
    expect(transport.postCount).toBe(0);
  });

  it("blocks a chat.postMessage response without a non-blank confirmed receipt", async () => {
    const projectCtx = ctx("blank_message_receipt");
    const transport = new ScriptedSlackProductTransport({
      channels: [{ id: "C_BIND", name: "selected", isMember: true }],
      postReceipt: { messageTs: " " },
    });
    const direct = provisioner(() => transport, await directSecrets());
    const plan = direct.plan(directRequirement(), projectCtx);
    const grant = await testOrgGrant({
      providerKind: "slack",
      capability: "messaging.send",
      operation: "bind",
      target: projectIntegrationOperationTarget(projectCtx, "C_BIND"),
      credentialRef: generationSecretRef(TOKEN_BASE, 1),
      metadata: { workspaceId: "T_DIRECT" },
      orgId: projectCtx.orgId,
      projectId: projectCtx.projectId,
    });

    await expect(direct.bind(grant, "C_BIND", plan, projectCtx)).rejects.toThrow(/incomplete_slack_evidence/u);
  });

  it("rejects a control-plane Slack output before a direct token read or provider mutation", async () => {
    const projectCtx = ctx("wrong_plane_output");
    let transportConstructed = 0;
    const direct = provisioner(
      () => {
        transportConstructed += 1;
        return new ScriptedSlackProductTransport();
      },
      await directSecrets(),
    );

    expect(() => direct.plan(goldenCrossPlaneForbiddenRequirement() as IntegrationRequirementV1, projectCtx)).toThrow(
      ProductProvisionFailedError,
    );
    expect(transportConstructed).toBe(0);
  });

  it("rejects a control-plane Slack grant even with a product-shaped direct plan", async () => {
    const projectCtx = ctx("wrong_plane_grant");
    let transportConstructed = 0;
    const direct = provisioner(
      () => {
        transportConstructed += 1;
        return new ScriptedSlackProductTransport();
      },
      await directSecrets(),
    );
    const plan = direct.plan(directRequirement(), projectCtx);
    const controlGrant = await testOrgGrant({
      providerKind: "slack",
      capability: "notify",
      operation: "provision",
      target: projectIntegrationOperationTarget(projectCtx),
      credentialRef: generationSecretRef(TOKEN_BASE, 1),
      metadata: { workspaceId: "T_DIRECT" },
      orgId: projectCtx.orgId,
      projectId: projectCtx.projectId,
    });

    await expect(direct.provision(controlGrant, plan, projectCtx)).rejects.toThrow(ProductProvisionFailedError);
    expect(transportConstructed).toBe(0);
  });

  it("returns only the direct token coordinate, never the plaintext token, in its artifact", async () => {
    const projectCtx = ctx("secret_artifact");
    const direct = provisioner(() => new ScriptedSlackProductTransport(), await directSecrets());
    const plan = direct.plan(directRequirement(), projectCtx);
    const artifact = await direct.provision(await directGrant(projectCtx), plan, projectCtx);

    expect(JSON.stringify(artifact)).not.toContain(TOKEN);
    expect(artifact.outputs.find((output) => output.output.logicalKey === "SLACK_BOT_TOKEN")?.secretSource).toEqual({
      ref: generationSecretRef(TOKEN_BASE, 1),
      generation: 1,
    });
  });
});

describe("FetchSlackProductTransport", () => {
  it("uses the real chat.postMessage Slack endpoint and returns only non-secret confirmation fields", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const transport = new FetchSlackProductTransport(async () => TOKEN, ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, channel: "C_DIRECT", ts: "1700.0001" })));
    }) as typeof fetch);

    await expect(transport.postMessage("C_DIRECT", "binding confirmed")).resolves.toEqual({
      channelId: "C_DIRECT",
      messageTs: "1700.0001",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it("rejects a wrong-type Slack confirmation rather than fabricating a receipt", async () => {
    const transport = new FetchSlackProductTransport(async () => TOKEN, (() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, channel: "C_DIRECT", ts: 1 })))) as typeof fetch);

    await expect(transport.postMessage("C_DIRECT", "binding confirmed")).rejects.toThrow(/malformed_slack_response/u);
  });
});
