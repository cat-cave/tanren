/* eslint-disable import/max-dependencies -- multi-impl product-provisioner conformance registry */
// Per-implementation invocations of the product-plane ApplicationIntegrationProvisioner
// conformance suite + registry / production-resolver / fail-closed coverage. The
// SAME vertical spec is proven against the REAL managed-relay provisioner (driven
// over a scripted relay transport) AND an in-memory fake — the dual-impl assertion
// that a new provider is a new impl + registry entry, not a refactor. A DB-backed
// materialization test proves the artifact is accepted by the in-14 BindingMaterializer.

import { describe, expect, it } from "vitest";
import { testOrgGrant } from "../helpers/orgGrant.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { systemActor } from "../../src/engine/state/actor.js";
import { generationSecretRef } from "../../src/engine/contracts/integrationSecretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../../src/engine/integrations/integrationSecretStoreImpl.js";
import { materializeBinding } from "../../src/engine/integrations/bindingMaterializer.js";
import { BindingMaterializerMemoryDb } from "../helpers/bindingMaterializerMemoryDb.js";
import {
  buildApplicationIntegrationProvisioner,
  ProductProvisionFailedError,
  registeredApplicationProviderKinds,
  UnconfiguredApplicationIntegrationProvisioner,
  type ApplicationIntegrationProvisioner,
  type ProvisionedApplicationArtifact,
} from "../../src/engine/contracts/applicationIntegrationProvisioner.js";
import {
  RelayMessagingProvisioner,
  RELAY_MESSAGING_PROVIDER_KIND,
  type ProductRelayTransport,
  type RelayBinding,
} from "../../src/engine/integrations/product/relayMessagingProvisioner.js";
import {
  FetchProductRelayTransport,
  PRODUCT_RELAY_URL_ENV,
  resolveProductionApplicationProvisioner,
} from "../../src/engine/integrations/product/applicationProvisionerProduction.js";
import {
  applicationArtifactToResolvedBinding,
  finalizeProductArtifact,
} from "../../src/engine/integrations/product/applicationProvisionerKit.js";
import {
  goldenProductMessagingRequirement,
  type IntegrationRequirementV1,
} from "../../src/engine/contracts/integrationRequirement.js";
import {
  projectIntegrationOperationTarget,
  type IntegrationOperationTarget,
  type IntegrationPrivilegedOperation,
} from "../../src/engine/contracts/integrationAuthority.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { ScriptedProductRelayTransport } from "./fakes/scriptedProductRelayTransport.js";
import { InMemoryApplicationIntegrationProvisioner } from "./fakes/inMemoryApplicationIntegrationProvisioner.js";
import { describeApplicationIntegrationProvisionerConformance } from "./applicationIntegrationProvisionerConformance.js";

const projectCtx = (projectId: string): ProjectContext => ({
  projectId,
  orgId: "org_conf",
  orgSlug: "acme",
  stack: "node",
  name: projectId,
});

// --- Real managed-relay provisioner over a scripted relay transport ------------
const RELAY_TOKEN_BASE = "secret://org/relay-control-token";
const RELAY_SEED: RelayBinding = {
  bindingId: "seed-binding-1",
  channelId: "seed-chan",
  channelName: "seeded-channel",
  stableKey: "seed:stable",
  workloadGeneration: 1,
  receiptId: "seed-receipt",
  created: false,
};

function makeRelay(): RelayMessagingProvisioner {
  const secrets = new InMemorySecretStore();
  void secrets.put({ ref: generationSecretRef(RELAY_TOKEN_BASE, 1), value: "relay-control-token-value" });
  return new RelayMessagingProvisioner(new ScriptedProductRelayTransport([RELAY_SEED]), secrets);
}

const relayGrant = (
  operation: IntegrationPrivilegedOperation,
  ctx: ProjectContext,
  target: IntegrationOperationTarget,
): Promise<OrgGrant> =>
  testOrgGrant({
    providerKind: "slack",
    capability: "messaging.send",
    operation,
    target,
    credentialRef: generationSecretRef(RELAY_TOKEN_BASE, 1),
    metadata: { workspaceId: "T123" },
    orgId: ctx.orgId,
    projectId: ctx.projectId,
  });

describeApplicationIntegrationProvisionerConformance("RelayMessagingProvisioner (scripted relay)", {
  make: makeRelay,
  requirement: () => goldenProductMessagingRequirement(),
  grant: relayGrant,
  projectCtx,
  seededResourceId: RELAY_SEED.bindingId,
});

// --- In-memory fake exercising a secret_ref output -----------------------------
const FAKE_SEED = {
  id: "product.memory-fake:seed",
  label: "seeded-product-resource",
  metadata: {},
  stableKey: "seed:key",
  workloadGeneration: 1,
  created: false,
};

/** A product messaging requirement with a SECRET output (direct-mode webhook ref). */
function fakeRequirement(): IntegrationRequirementV1 {
  return {
    ...goldenProductMessagingRequirement(),
    bindingOutputs: [
      {
        version: 1,
        kind: "product.messaging.webhook_url_ref",
        logicalKey: "PRODUCT_SLACK_WEBHOOK_URL_REF",
        classification: "secret_ref",
        required: true,
      },
      {
        version: 1,
        kind: "product.messaging.channel_id",
        logicalKey: "PRODUCT_SLACK_CHANNEL_ID",
        classification: "plain",
        required: true,
      },
    ],
  };
}

function makeFake(): InMemoryApplicationIntegrationProvisioner {
  return new InMemoryApplicationIntegrationProvisioner({ capabilities: ["messaging.send"], existing: [FAKE_SEED] });
}

const fakeGrant = (
  operation: IntegrationPrivilegedOperation,
  ctx: ProjectContext,
  target: IntegrationOperationTarget,
): Promise<OrgGrant> =>
  testOrgGrant({
    providerKind: "slack",
    capability: "messaging.send",
    operation,
    target,
    metadata: { workspaceId: "T123" },
    orgId: ctx.orgId,
    projectId: ctx.projectId,
  });

describeApplicationIntegrationProvisionerConformance("InMemoryApplicationIntegrationProvisioner", {
  make: makeFake,
  requirement: fakeRequirement,
  grant: fakeGrant,
  projectCtx,
  seededResourceId: FAKE_SEED.id,
});

// --- VERTICAL (DB): the artifact is ACCEPTED by the in-14 BindingMaterializer ---
describe("ApplicationIntegrationProvisioner vertical materialization (in-14 seam)", () => {
  it("materializes the fake's artifact into project_app_env incl. a scoped secret", async () => {
    const ctx = projectCtx("proj_mat");
    const provisioner = makeFake();
    const plan = provisioner.plan(fakeRequirement(), ctx);
    const grant = await fakeGrant("provision", ctx, projectIntegrationOperationTarget(ctx));
    const artifact = await provisioner.provision(grant, plan, ctx);
    const resolved = applicationArtifactToResolvedBinding(artifact, grant, ctx, plan);

    // Preload the secret SOURCE material the fake's coordinate points at.
    const backing = new InMemorySecretStore();
    const secretOutput = resolved.outputs.find((output) => output.secret);
    expect(secretOutput?.secretSource).toBeDefined();
    await backing.put({ ref: secretOutput?.secretSource?.ref as string, value: "https://hooks.example/T/B/xyz" });
    const secrets = new GenerationAddressedIntegrationSecretStore(backing);

    const result = await materializeBinding(new BindingMaterializerMemoryDb(), secrets, resolved, systemActor);
    expect(result.reused).toBe(false);
    expect(result.materializedKeys).toContain("PRODUCT_SLACK_WEBHOOK_URL_REF");
    expect(result.materializedKeys).toContain("PRODUCT_SLACK_CHANNEL_ID");
  });
});

// --- Registry + production resolver + fail-closed -------------------------------
describe("buildApplicationIntegrationProvisioner registry", () => {
  it("exposes the registered product kinds", () => {
    expect(registeredApplicationProviderKinds()).toContain(RELAY_MESSAGING_PROVIDER_KIND);
  });

  it("builds the real RelayMessagingProvisioner from relay + secrets deps", () => {
    const provisioner = buildApplicationIntegrationProvisioner(RELAY_MESSAGING_PROVIDER_KIND, {
      relay: new ScriptedProductRelayTransport(),
      secrets: new InMemorySecretStore(),
    });
    expect(provisioner).toBeInstanceOf(RelayMessagingProvisioner);
    expect(provisioner.capability()).toEqual(["messaging.send"]);
  });

  it("without relay deps throws (no silent stub)", () => {
    expect(() =>
      buildApplicationIntegrationProvisioner(RELAY_MESSAGING_PROVIDER_KIND, { secrets: new InMemorySecretStore() }),
    ).toThrow(ProductProvisionFailedError);
  });

  it("an unregistered kind resolves to the hard-throw Unconfigured provisioner", () => {
    const provisioner = buildApplicationIntegrationProvisioner("product.unknown");
    expect(provisioner).toBeInstanceOf(UnconfiguredApplicationIntegrationProvisioner);
    expect(() => provisioner.capability()).toThrow(/not registered/u);
  });

  it("every op on the unconfigured provisioner throws loudly (never a silent no-op)", async () => {
    const provisioner = buildApplicationIntegrationProvisioner("product.unknown");
    const ctx = projectCtx("p");
    expect(() => provisioner.capability()).toThrow(ProductProvisionFailedError);
    await expect((provisioner as ApplicationIntegrationProvisioner).teardown(undefined as never, ctx)).rejects.toThrow(
      ProductProvisionFailedError,
    );
  });
});

describe("resolveProductionApplicationProvisioner (production wiring)", () => {
  it("resolves the concrete impl (never the fake) when the relay is configured", () => {
    const prior = process.env[PRODUCT_RELAY_URL_ENV];
    process.env[PRODUCT_RELAY_URL_ENV] = "https://relay.example";
    try {
      const provisioner = resolveProductionApplicationProvisioner(
        RELAY_MESSAGING_PROVIDER_KIND,
        new InMemorySecretStore(),
      );
      expect(provisioner).toBeInstanceOf(RelayMessagingProvisioner);
    } finally {
      restoreEnv(PRODUCT_RELAY_URL_ENV, prior);
    }
  });

  it("fails closed when the relay endpoint is not configured", () => {
    const prior = process.env[PRODUCT_RELAY_URL_ENV];
    delete process.env[PRODUCT_RELAY_URL_ENV];
    try {
      expect(() =>
        resolveProductionApplicationProvisioner(RELAY_MESSAGING_PROVIDER_KIND, new InMemorySecretStore()),
      ).toThrow(ProductProvisionFailedError);
    } finally {
      restoreEnv(PRODUCT_RELAY_URL_ENV, prior);
    }
  });
});

describe("RelayMessagingProvisioner fail-closed", () => {
  it("provision fails closed (typed error) when the relay transport errors", async () => {
    const ctx = projectCtx("proj_fail");
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: generationSecretRef(RELAY_TOKEN_BASE, 1), value: "t" });
    // A real (empty) transport whose CREATE rejects — provision finds no binding,
    // calls registerBinding, and must surface the relay error as a typed failure.
    const throwing = new ScriptedProductRelayTransport();
    // eslint-disable-next-line @typescript-eslint/require-await
    throwing.registerBinding = async () => {
      throw new Error("relay 500");
    };
    const provisioner = new RelayMessagingProvisioner(throwing, secrets);
    const plan = provisioner.plan(goldenProductMessagingRequirement(), ctx);
    await expect(
      provisioner.provision(await relayGrant("provision", ctx, projectIntegrationOperationTarget(ctx)), plan, ctx),
    ).rejects.toThrow(ProductProvisionFailedError);
  });
});

// --- Audit fail-closed arms: no fabricated success on unconfirmed evidence -----

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

async function relaySecrets(): Promise<InMemorySecretStore> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: generationSecretRef(RELAY_TOKEN_BASE, 1), value: "relay-control-token-value" });
  return secrets;
}

/** A fake fetch that always returns the given status + JSON body (or empty). */
function fetchReturning(status: number, body?: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;
}

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
    // A minimal plan; the seam only needs its ids/environment.
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

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prior;
  }
}
