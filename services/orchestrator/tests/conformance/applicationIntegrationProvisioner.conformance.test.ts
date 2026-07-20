/* eslint-disable import/max-dependencies -- multi-impl product-provisioner conformance registry */
// Per-implementation invocations of the product-plane ApplicationIntegrationProvisioner
// conformance suite + registry / production-resolver coverage. The SAME vertical spec
// is proven against the REAL managed-relay provisioner (over a scripted relay
// transport) AND an in-memory fake — the dual-impl assertion that a new provider is a
// new impl + registry entry, not a refactor. A DB-backed materialization test proves
// the artifact is accepted by the in-14 BindingMaterializer. The fail-closed /
// fabricated-success arms live in the sibling fail-closed test file.

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
} from "../../src/engine/contracts/applicationIntegrationProvisioner.js";
import {
  RelayMessagingProvisioner,
  RELAY_MESSAGING_PROVIDER_KIND,
  type RelayBinding,
} from "../../src/engine/integrations/product/relayMessagingProvisioner.js";
import {
  PRODUCT_RELAY_URL_ENV,
  resolveProductionApplicationProvisioner,
} from "../../src/engine/integrations/product/applicationProvisionerProduction.js";
import { applicationArtifactToResolvedBinding } from "../../src/engine/integrations/product/applicationProvisionerKit.js";
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
import { RELAY_TOKEN_BASE, relayGrant, relayProjectCtx as projectCtx } from "./fakes/relayProvisionerFixtures.js";

// --- Real managed-relay provisioner over a scripted relay transport ------------
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

// --- Registry + production resolver ---------------------------------------------
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

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prior;
  }
}
