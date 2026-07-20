/**
 * in-14 fast (no-Postgres) happy-path proofs for the BindingMaterializer store +
 * the deploy-path reconcile core, against a focused in-memory query client. Real
 * schema/RLS/FK behavior is proven separately by the real-Postgres suite; this
 * covers the SQL-issuing store logic + reconcile loop deterministically.
 */
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { generationSecretRef } from "../src/engine/contracts/integrationSecretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import { materializeBinding, type ResolvedBinding } from "../src/engine/integrations/bindingMaterializer.js";
import { reconcileReadyBindings } from "../src/engine/postMerge/materializeProjectBindings.js";
import { systemActor } from "../src/engine/state/actor.js";
import { BindingMaterializerMemoryDb } from "./helpers/bindingMaterializerMemoryDb.js";

const ORG = "org_a";
const PROJECT = "proj_a";
const BIND = "bind_a";
const CRED = "secret://org/org_a/slack/connection/conn_a/token";
const MATERIAL = "xoxb-material";

function resolved(channel: string): ResolvedBinding {
  return {
    orgId: ORG,
    projectId: PROJECT,
    requirementId: "req_a",
    environment: "production",
    bindingId: BIND,
    providerKind: "slack",
    connectionId: "conn_a",
    authGeneration: 1,
    grantId: "grant_a",
    grantGeneration: 1,
    adapterVersion: "slack.v1",
    externalResourceId: "C1",
    externalResourceName: "general",
    ownership: "created",
    teardownPolicy: "delete",
    outputs: [
      {
        logicalKey: "SLACK_BOT_TOKEN",
        secret: true,
        required: true,
        scopes: ["runtime"],
        secretSource: { ref: CRED, generation: 1 },
      },
      { logicalKey: "SLACK_CHANNEL_ID", secret: false, required: true, scopes: ["runtime"], plainValue: channel },
    ],
  };
}

function newSecrets(): GenerationAddressedIntegrationSecretStore {
  const backing = new InMemorySecretStore();
  void backing.put({ ref: generationSecretRef(CRED, 1), value: MATERIAL });
  return new GenerationAddressedIntegrationSecretStore(backing);
}

describe("BindingMaterializer — in-memory happy path", () => {
  it("materializes generation 1: env shape, provisioned app env, scoped secret", async () => {
    const db = new BindingMaterializerMemoryDb();
    const secrets = newSecrets();
    const result = await materializeBinding(db, secrets, resolved("C1"), systemActor);

    expect(result).toMatchObject({ bindingId: BIND, generation: 1, reused: false });
    expect(result.materializedKeys).toEqual(["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"]);
    expect(db.generations).toHaveLength(1);
    expect(db.env.map((e) => e["classification"])).toEqual(["secret", "non_secret"]);

    const token = db.appEnv.find((r) => r["key"] === "SLACK_BOT_TOKEN");
    expect(token?.["value_ref"]).toBe(`secret://org/${ORG}/project/${PROJECT}/binding/${BIND}/env/SLACK_BOT_TOKEN/g/1`);
    expect(token?.["secret_generation"]).toBe(1);
    expect(await secrets.getExact({ ref: token?.["value_ref"] as string, generation: 1 })).toBe(MATERIAL);
    expect(db.bindings[0]).toMatchObject({ current_generation: 1, status: "ready" });
  });

  it("is idempotent for identical content and mints the next generation on change", async () => {
    const db = new BindingMaterializerMemoryDb();
    const secrets = newSecrets();
    await materializeBinding(db, secrets, resolved("C1"), systemActor);

    const again = await materializeBinding(db, secrets, resolved("C1"), systemActor);
    expect(again).toMatchObject({ generation: 1, reused: true });
    expect(db.generations).toHaveLength(1);

    const changed = await materializeBinding(db, secrets, resolved("C2"), systemActor);
    expect(changed).toMatchObject({ generation: 2, reused: false });
    expect(db.generations).toHaveLength(2);
    expect(db.appEnv.find((r) => r["key"] === "SLACK_CHANNEL_ID")?.["plain_value"]).toBe("C2");
  });

  it("the deploy-path reconcile re-materializes a ready binding idempotently", async () => {
    const db = new BindingMaterializerMemoryDb();
    db.seedAuthGeneration({
      orgId: ORG,
      providerKind: "slack",
      connectionId: "conn_a",
      generation: 1,
      credentialRef: CRED,
    });
    const secrets = newSecrets();
    await materializeBinding(db, secrets, resolved("C1"), systemActor);

    const reconciled = await reconcileReadyBindings(db, {
      secrets,
      orgId: ORG,
      projectId: PROJECT,
      environment: "production",
      actor: systemActor,
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ bindingId: BIND, generation: 1, reused: true });
    expect(db.generations).toHaveLength(1);
  });
});
