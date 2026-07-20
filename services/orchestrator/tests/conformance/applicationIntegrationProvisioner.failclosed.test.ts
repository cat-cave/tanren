/* eslint-disable import/max-dependencies -- fail-closed arms span the kit + impl + transport */
// Fail-closed / no-fabricated-success arms for the product-plane relay provisioner.
// A provisioning authority must NEVER report success without confirmed external
// evidence. Split from the conformance file to respect the 500-line source cap;
// shares fixtures via `relayProvisionerFixtures`.

import { describe, expect, it } from "vitest";
import {
  ProductProvisionFailedError,
  type ProvisionedApplicationArtifact,
} from "../../src/engine/contracts/applicationIntegrationProvisioner.js";
import {
  RelayMessagingProvisioner,
  RELAY_MESSAGING_PROVIDER_KIND,
  type ProductRelayTransport,
  type RelayBinding,
} from "../../src/engine/integrations/product/relayMessagingProvisioner.js";
import { FetchProductRelayTransport } from "../../src/engine/integrations/product/applicationProvisionerProduction.js";
import {
  applicationArtifactToResolvedBinding,
  finalizeProductArtifact,
} from "../../src/engine/integrations/product/applicationProvisionerKit.js";
import { goldenProductMessagingRequirement } from "../../src/engine/contracts/integrationRequirement.js";
import { projectIntegrationOperationTarget } from "../../src/engine/contracts/integrationAuthority.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { ScriptedProductRelayTransport } from "./fakes/scriptedProductRelayTransport.js";
import {
  fetchReturning,
  relayGrant,
  relayProjectCtx as projectCtx,
  relaySecrets,
  relayTransportReturning,
} from "./fakes/relayProvisionerFixtures.js";

const INCOMPLETE_BINDING: RelayBinding = {
  bindingId: "b1",
  channelId: "",
  channelName: "",
  stableKey: "org_conf:proj_ev:messaging.send",
  workloadGeneration: 1,
  receiptId: "",
  created: true,
};
const COMPLETE_BINDING: RelayBinding = {
  bindingId: "b1",
  channelId: "c1",
  channelName: "chan",
  stableKey: "org_conf:proj_td:messaging.send",
  workloadGeneration: 1,
  receiptId: "r1",
  created: true,
};

/** A transport that returns INCOMPLETE evidence (empty channel/receipt) everywhere. */
class IncompleteEvidenceTransport implements ProductRelayTransport {
  registerBinding(): Promise<RelayBinding> {
    return Promise.resolve(INCOMPLETE_BINDING);
  }
  getBinding(): Promise<RelayBinding | undefined> {
    return Promise.resolve(INCOMPLETE_BINDING);
  }
  listBindings(): Promise<readonly RelayBinding[]> {
    return Promise.resolve([INCOMPLETE_BINDING]);
  }
  rotateWorkloadCredential(): Promise<RelayBinding> {
    return Promise.resolve(INCOMPLETE_BINDING);
  }
  revokeBinding(): Promise<void> {
    return Promise.resolve();
  }
}

/** A transport that finds a created binding but whose DELETE is never confirmed. */
class UnconfirmedTeardownTransport implements ProductRelayTransport {
  registerBinding(): Promise<RelayBinding> {
    return Promise.resolve(COMPLETE_BINDING);
  }
  getBinding(): Promise<RelayBinding | undefined> {
    return Promise.resolve(COMPLETE_BINDING);
  }
  listBindings(): Promise<readonly RelayBinding[]> {
    return Promise.resolve([COMPLETE_BINDING]);
  }
  rotateWorkloadCredential(): Promise<RelayBinding> {
    return Promise.resolve(COMPLETE_BINDING);
  }
  revokeBinding(): Promise<void> {
    return Promise.reject(new Error("relay DELETE /v1/bindings/b1 failed: HTTP 404"));
  }
}

async function expectAllMutationsBlocked(binding: RelayBinding, projectId: string): Promise<void> {
  const ctx = projectCtx(projectId);
  const provisioner = new RelayMessagingProvisioner(relayTransportReturning(binding), await relaySecrets());
  const plan = provisioner.plan(goldenProductMessagingRequirement(), ctx);
  await expect(
    provisioner.provision(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), plan, ctx),
  ).rejects.toThrow(ProductProvisionFailedError);
  await expect(
    provisioner.bind(
      await relayGrant("bind", ctx, projectIntegrationOperationTarget(ctx, binding.bindingId)),
      binding.bindingId,
      plan,
      ctx,
    ),
  ).rejects.toThrow(ProductProvisionFailedError);
  await expect(
    provisioner.rotate(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), plan, ctx),
  ).rejects.toThrow(ProductProvisionFailedError);
}

describe("RelayMessagingProvisioner fail-closed", () => {
  it("provision fails closed (typed error) when the relay transport errors", async () => {
    const ctx = projectCtx("proj_fail");
    // A real (empty) transport whose CREATE rejects — provision finds no binding,
    // calls registerBinding, and must surface the relay error as a typed failure.
    const throwing = new ScriptedProductRelayTransport();
    // eslint-disable-next-line @typescript-eslint/require-await
    throwing.registerBinding = async () => {
      throw new Error("relay 500");
    };
    const provisioner = new RelayMessagingProvisioner(throwing, await relaySecrets());
    const plan = provisioner.plan(goldenProductMessagingRequirement(), ctx);
    await expect(
      provisioner.provision(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), plan, ctx),
    ).rejects.toThrow(ProductProvisionFailedError);
  });
});

describe("FINDING 1 — provision/bind/rotate fail closed on incomplete relay evidence", () => {
  it("parseRelayBinding hard-fails when the relay omits confirmation fields (registerBinding)", async () => {
    const transport = new FetchProductRelayTransport("https://relay.example", fetchReturning(200, { bindingId: "b1" }));
    await expect(
      transport.registerBinding("tok", {
        orgId: "o",
        projectId: "p",
        stableKey: "k",
        providerName: "slack",
        channelName: "c",
        providerPrincipalId: "T1",
        requiredOperations: [],
        requiredScopes: [],
      }),
    ).rejects.toThrow(ProductProvisionFailedError);
  });

  it("provision, bind, and rotate each reject (no success artifact with empty channel_id)", async () => {
    const ctx = projectCtx("proj_ev");
    const provisioner = new RelayMessagingProvisioner(new IncompleteEvidenceTransport(), await relaySecrets());
    const plan = provisioner.plan(goldenProductMessagingRequirement(), ctx);
    const provisionGrant = await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx));
    await expect(provisioner.provision(provisionGrant, plan, ctx)).rejects.toThrow(ProductProvisionFailedError);
    await expect(
      provisioner.bind(await relayGrant("bind", ctx, projectIntegrationOperationTarget(ctx, "b1")), "b1", plan, ctx),
    ).rejects.toThrow(ProductProvisionFailedError);
    await expect(provisioner.rotate(provisionGrant, plan, ctx)).rejects.toThrow(ProductProvisionFailedError);
  });

  it("the vertical seam rejects an empty plain value (empty channel_id cannot reach app env)", () => {
    const bad: ProvisionedApplicationArtifact = {
      providerKind: RELAY_MESSAGING_PROVIDER_KIND,
      adapterVersion: "1.0.0",
      externalResourceId: "b1",
      externalResourceName: "chan",
      ownership: "created",
      outputs: [
        {
          output: {
            version: 1,
            kind: "product.messaging.channel_id",
            logicalKey: "PRODUCT_SLACK_CHANNEL_ID",
            classification: "plain",
            required: true,
          },
          plainValue: "",
        },
      ],
    };
    const ctx = projectCtx("proj_seam");
    const plan = new RelayMessagingProvisioner(new IncompleteEvidenceTransport(), new InMemorySecretStore()).plan(
      goldenProductMessagingRequirement(),
      ctx,
    );
    const grant = { connectionId: "c", authGeneration: 1, grantId: "g", grantGeneration: 1 } as never;
    expect(() => applicationArtifactToResolvedBinding(bad, grant, ctx, plan)).toThrow(ProductProvisionFailedError);
  });
});

describe("FINDING 2 — teardown fails closed when the delete is not confirmed", () => {
  it("a 404 DELETE of a known-created binding rejects (teardown_unconfirmed)", async () => {
    const ctx = projectCtx("proj_td");
    const provisioner = new RelayMessagingProvisioner(new UnconfirmedTeardownTransport(), await relaySecrets());
    await expect(
      provisioner.teardown(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), ctx),
    ).rejects.toThrow(/teardown_unconfirmed/u);
  });

  it("FetchProductRelayTransport.revokeBinding rejects on a 404 (no silent success)", async () => {
    const transport = new FetchProductRelayTransport("https://relay.example", fetchReturning(404));
    await expect(transport.revokeBinding("tok", "org", "b1")).rejects.toThrow(/HTTP 404/u);
  });
});

describe("FINDING 3 — discover fails closed on a malformed relay inventory", () => {
  it("a non-array listBindings body rejects (malformed_relay_inventory)", async () => {
    const transport = new FetchProductRelayTransport("https://relay.example", fetchReturning(200, { not: "an-array" }));
    await expect(transport.listBindings("tok", "org")).rejects.toThrow(/malformed_relay_inventory/u);
  });

  it("provision.discover surfaces the malformed inventory as a typed failure", async () => {
    const ctx = projectCtx("proj_inv");
    const transport = new FetchProductRelayTransport("https://relay.example", fetchReturning(200, { not: "an-array" }));
    const provisioner = new RelayMessagingProvisioner(transport, await relaySecrets());
    await expect(provisioner.discover(await relayGrant("discover", ctx, {}), ctx)).rejects.toThrow(
      ProductProvisionFailedError,
    );
  });
});

describe("FINDING 4 — the kit boundary rejects a control-plane output on any product artifact", () => {
  it("finalizeProductArtifact throws on a control.* binding kind", () => {
    const poisoned: ProvisionedApplicationArtifact = {
      providerKind: RELAY_MESSAGING_PROVIDER_KIND,
      adapterVersion: "1.0.0",
      externalResourceId: "b1",
      externalResourceName: "chan",
      ownership: "created",
      outputs: [
        {
          output: {
            version: 1,
            kind: "control.notify.bot_token_ref",
            logicalKey: "SLACK_BOT_TOKEN",
            classification: "secret_ref",
            required: true,
          },
          secretSource: { ref: "secret://control/bot-token/g/1", generation: 1 },
        },
      ],
    };
    expect(() => finalizeProductArtifact(poisoned, "provision")).toThrow(ProductProvisionFailedError);
  });
});

describe("RE-AUDIT F1 — whitespace-only confirmation fields are blocked (non-blank)", () => {
  const whitespace: RelayBinding = {
    bindingId: "b1",
    channelId: "   ",
    channelName: "\t",
    stableKey: "k",
    workloadGeneration: 1,
    receiptId: " ",
    created: true,
  };

  it("provision/bind/rotate block when the relay returns whitespace-only channel evidence", async () => {
    await expectAllMutationsBlocked(whitespace, "proj_ws");
  });

  it("parseRelayBinding rejects a whitespace-only channelId (fetch parser)", async () => {
    const transport = new FetchProductRelayTransport(
      "https://relay.example",
      fetchReturning(200, { ...whitespace, channelName: "chan", receiptId: "r1" }),
    );
    await expect(
      transport.registerBinding("tok", {
        orgId: "o",
        projectId: "p",
        stableKey: "k",
        providerName: "slack",
        channelName: "c",
        providerPrincipalId: "T1",
        requiredOperations: [],
        requiredScopes: [],
      }),
    ).rejects.toThrow(ProductProvisionFailedError);
  });
});

describe("RE-AUDIT F2 — an empty binding id is blocked at the provisioner (not just the seam)", () => {
  // A non-fetch transport returning bindingId:'' with FULL channels. (bind cannot
  // reach this guard: its find-by-id requires a real resource id to match, and the
  // authority rejects a blank bind target — so provision/rotate are the surfaces
  // that reuse the transport's binding directly.)
  const blankId: RelayBinding = {
    bindingId: "",
    channelId: "c1",
    channelName: "chan",
    stableKey: "k",
    workloadGeneration: 1,
    receiptId: "r1",
    created: true,
  };

  it("provision and rotate block at the provisioner (empty externalResourceId never confirmed)", async () => {
    const ctx = projectCtx("proj_blank_id");
    const provisioner = new RelayMessagingProvisioner(relayTransportReturning(blankId), await relaySecrets());
    const plan = provisioner.plan(goldenProductMessagingRequirement(), ctx);
    await expect(
      provisioner.provision(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), plan, ctx),
    ).rejects.toThrow(ProductProvisionFailedError);
    await expect(
      provisioner.rotate(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), plan, ctx),
    ).rejects.toThrow(ProductProvisionFailedError);
  });

  it("assertion also rejects a blank stableKey (re-asserted at the provisioner)", async () => {
    const ctx = projectCtx("proj_blank_key");
    const blankKey: RelayBinding = {
      bindingId: "b1",
      channelId: "c1",
      channelName: "chan",
      stableKey: "  ",
      workloadGeneration: 1,
      receiptId: "r1",
      created: true,
    };
    const provisioner = new RelayMessagingProvisioner(relayTransportReturning(blankKey), await relaySecrets());
    const plan = provisioner.plan(goldenProductMessagingRequirement(), ctx);
    await expect(
      provisioner.provision(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), plan, ctx),
    ).rejects.toThrow(/stableKey/u);
  });
});

describe("RE-AUDIT F3 — a 2xx empty getBinding body is malformed, not 'absent'", () => {
  it("FetchProductRelayTransport.getBinding rejects on a 2xx empty body (no phantom absence)", async () => {
    const transport = new FetchProductRelayTransport("https://relay.example", fetchReturning(200));
    await expect(transport.getBinding("tok", "org", "k")).rejects.toThrow(/malformed_relay_binding/u);
  });

  it("teardown does NOT report a no-op success when getBinding returns a 2xx empty body", async () => {
    const ctx = projectCtx("proj_2xx_empty");
    const transport = new FetchProductRelayTransport("https://relay.example", fetchReturning(200));
    const provisioner = new RelayMessagingProvisioner(transport, await relaySecrets());
    await expect(
      provisioner.teardown(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), ctx),
    ).rejects.toThrow(ProductProvisionFailedError);
  });

  it("teardown IS a no-op success on a CONFIRMED 404 absence", async () => {
    const ctx = projectCtx("proj_404_absent");
    const transport = new FetchProductRelayTransport("https://relay.example", fetchReturning(404));
    const provisioner = new RelayMessagingProvisioner(transport, await relaySecrets());
    await expect(
      provisioner.teardown(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), ctx),
    ).resolves.toBeUndefined();
  });
});
