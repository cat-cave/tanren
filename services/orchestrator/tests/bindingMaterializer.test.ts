/**
 * in-14 unit proofs: BindingMaterializer fail-closed validation + secret
 * resolution, with NO database. Every fault path must throw a typed error BEFORE
 * the materializer issues a single query (a throwing client proves no partial
 * write), and before it mints any Vault secret.
 */
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import {
  bindingEnvSecretBaseRef,
  BindingOutputInvalidError,
  BindingSecretUnresolvedError,
  materializeBinding,
  type ResolvedBinding,
  type ResolvedBindingOutput,
} from "../src/engine/integrations/bindingMaterializer.js";
import type { IntegrationQueryClient } from "../src/engine/repositories/integrationQuery.js";
import { systemActor } from "../src/engine/state/actor.js";

/** A client that fails if touched — proves fail-closed paths never write. */
const throwingClient: IntegrationQueryClient = {
  query: async () => {
    throw new Error("materializeBinding must not query the database on a fail-closed path");
  },
};

function resolved(outputs: ResolvedBindingOutput[], resource = "C123"): ResolvedBinding {
  return {
    orgId: "org_a",
    projectId: "proj_a",
    requirementId: "req_a",
    environment: "production",
    bindingId: "bind_a",
    providerKind: "slack",
    connectionId: "conn_a",
    authGeneration: 1,
    grantId: "grant_a",
    grantGeneration: 1,
    adapterVersion: "slack.v1",
    externalResourceId: resource,
    externalResourceName: resource === "" ? "" : "general",
    ownership: "created",
    teardownPolicy: "delete",
    outputs,
  };
}

const emptySecrets = () => new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());

describe("BindingMaterializer — fail-closed validation (no DB)", () => {
  it("rejects a binding with no app-env outputs", async () => {
    await expect(materializeBinding(throwingClient, emptySecrets(), resolved([]), systemActor)).rejects.toBeInstanceOf(
      BindingOutputInvalidError,
    );
  });

  it("rejects a materialization with no provisioned external resource", async () => {
    const output: ResolvedBindingOutput = {
      logicalKey: "K",
      secret: false,
      required: true,
      scopes: ["runtime"],
      plainValue: "v",
    };
    await expect(
      materializeBinding(throwingClient, emptySecrets(), resolved([output], ""), systemActor),
    ).rejects.toBeInstanceOf(BindingOutputInvalidError);
  });

  it("rejects an invalid env key", async () => {
    const output: ResolvedBindingOutput = {
      logicalKey: "not-a-key",
      secret: false,
      required: true,
      scopes: [],
      plainValue: "v",
    };
    await expect(
      materializeBinding(throwingClient, emptySecrets(), resolved([output]), systemActor),
    ).rejects.toBeInstanceOf(BindingOutputInvalidError);
  });

  it("rejects a duplicate output key", async () => {
    const out: ResolvedBindingOutput = {
      logicalKey: "DUP",
      secret: false,
      required: true,
      scopes: [],
      plainValue: "v",
    };
    await expect(
      materializeBinding(throwingClient, emptySecrets(), resolved([out, out]), systemActor),
    ).rejects.toBeInstanceOf(BindingOutputInvalidError);
  });

  it("rejects a secret output missing its source", async () => {
    const output: ResolvedBindingOutput = { logicalKey: "TOKEN", secret: true, required: true, scopes: ["runtime"] };
    await expect(
      materializeBinding(throwingClient, emptySecrets(), resolved([output]), systemActor),
    ).rejects.toBeInstanceOf(BindingOutputInvalidError);
  });

  it("rejects a secret output that also carries a plain value", async () => {
    const output: ResolvedBindingOutput = {
      logicalKey: "TOKEN",
      secret: true,
      required: true,
      scopes: ["runtime"],
      secretSource: { ref: "secret://x/token", generation: 1 },
      plainValue: "leak",
    };
    await expect(
      materializeBinding(throwingClient, emptySecrets(), resolved([output]), systemActor),
    ).rejects.toBeInstanceOf(BindingOutputInvalidError);
  });

  it("rejects a non-secret output missing its plain value", async () => {
    const output: ResolvedBindingOutput = { logicalKey: "URL", secret: false, required: true, scopes: [] };
    await expect(
      materializeBinding(throwingClient, emptySecrets(), resolved([output]), systemActor),
    ).rejects.toBeInstanceOf(BindingOutputInvalidError);
  });

  it("fails closed (no query, no mint) when a required secret source is unresolvable", async () => {
    const output: ResolvedBindingOutput = {
      logicalKey: "TOKEN",
      secret: true,
      required: true,
      scopes: ["runtime"],
      secretSource: { ref: "secret://absent/token", generation: 1 },
    };
    // The source secret was never staged into the store → getExact yields nothing.
    await expect(
      materializeBinding(throwingClient, emptySecrets(), resolved([output]), systemActor),
    ).rejects.toBeInstanceOf(BindingSecretUnresolvedError);
  });
});

describe("bindingEnvSecretBaseRef", () => {
  it("is org + project + binding + key scoped and least-privilege", () => {
    expect(bindingEnvSecretBaseRef("org_a", "proj_a", "bind_a", "SLACK_TOKEN")).toBe(
      "secret://org/org_a/project/proj_a/binding/bind_a/env/SLACK_TOKEN",
    );
  });

  it("percent-encodes hostile identifiers", () => {
    expect(bindingEnvSecretBaseRef("o/x", "p", "b", "K")).toContain("secret://org/o%2Fx/");
  });
});
