/**
 * in-15 fast (no-Postgres) proofs for the appEnvHash proof gate. A binding is
 * materialized (in-14) into a focused in-memory query client, then the gate
 * independently recomputes its appEnvHash and verifies (or blocks) it. Real
 * schema/RLS/FK behavior is proven separately by the real-Postgres suite; this
 * covers the verdict logic + tamper-evidence deterministically.
 */
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { generationSecretRef } from "../src/engine/contracts/integrationSecretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import { materializeBinding, type ResolvedBinding } from "../src/engine/integrations/bindingMaterializer.js";
import {
  assertReadyProjectBindingProofs,
  BindingAppEnvProofFailedError,
  verifyBindingAppEnvProof,
  verifyReadyProjectBindingProofs,
  type ProjectBindingProofScope,
} from "../src/engine/integrations/bindingAppEnvProof.js";
import { systemActor } from "../src/engine/state/actor.js";
import { BindingMaterializerMemoryDb } from "./helpers/bindingMaterializerMemoryDb.js";

const ORG = "org_a";
const PROJECT = "proj_a";
const BIND = "bind_a";
const CONN = "conn_a";
const CRED = `secret://org/${ORG}/slack/connection/${CONN}/token`;
const MATERIAL = "xoxb-material";
const SCOPE: ProjectBindingProofScope = { orgId: ORG, projectId: PROJECT, environment: "production" };
const TOKEN_REF = `secret://org/${ORG}/project/${PROJECT}/binding/${BIND}/env/SLACK_BOT_TOKEN`;

function resolved(channel: string): ResolvedBinding {
  return {
    orgId: ORG,
    projectId: PROJECT,
    requirementId: "req_a",
    environment: "production",
    bindingId: BIND,
    providerKind: "slack",
    connectionId: CONN,
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

const PLAIN_CHANNEL = "CHANNEL-PLAINTEXT-XYZ";

async function materialized(channel = PLAIN_CHANNEL): Promise<{
  db: BindingMaterializerMemoryDb;
  secrets: GenerationAddressedIntegrationSecretStore;
  backing: InMemorySecretStore;
}> {
  const db = new BindingMaterializerMemoryDb();
  const backing = new InMemorySecretStore();
  void backing.put({ ref: generationSecretRef(CRED, 1), value: MATERIAL });
  const secrets = new GenerationAddressedIntegrationSecretStore(backing);
  await materializeBinding(db, secrets, resolved(channel), systemActor);
  return { db, secrets, backing };
}

describe("in-15 appEnvHash proof gate — verdicts", () => {
  it("verifies a correctly-materialized binding and returns a frozen contract", async () => {
    const { db, secrets } = await materialized();
    const verdict = await verifyBindingAppEnvProof(db, secrets, SCOPE, BIND);

    expect(verdict.status).toBe("verified");
    if (verdict.status !== "verified") return;
    expect(verdict.generation).toBe(1);
    expect(verdict.appEnvHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The contract carries the immutable shape + the recorded hash, never a value.
    expect(verdict.contract.appEnvHash).toBe(verdict.appEnvHash);
    expect(verdict.contract.outputs.map((o) => o.logicalKey)).toEqual(["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"]);
    expect(Object.isFrozen(verdict.contract)).toBe(true);
    // The frozen contract carries the immutable shape + resource identity + hash —
    // NEVER a secret value or a plain config value.
    expect(JSON.stringify(verdict.contract)).not.toContain(MATERIAL);
    expect(JSON.stringify(verdict.contract)).not.toContain(PLAIN_CHANNEL);
  });

  it("BLOCKS on a tampered plain env value (hash mismatch) — tamper-evident", async () => {
    const { db, secrets } = await materialized();
    // Tamper one env value directly in project_app_env (bypassing the materializer).
    const channel = db.appEnv.find((r) => r["key"] === "SLACK_CHANNEL_ID");
    expect(channel).toBeDefined();
    channel!["plain_value"] = "C-HACKED";

    const verdict = await verifyBindingAppEnvProof(db, secrets, SCOPE, BIND);
    expect(verdict.status).toBe("hash_mismatch");
    if (verdict.status !== "hash_mismatch") return;
    expect(verdict.recomputedHash).not.toBe(verdict.recordedHash);
  });

  it("BLOCKS on a tampered secret value at the scoped coordinate (hash mismatch)", async () => {
    const { db, secrets, backing } = await materialized();
    // Overwrite the scoped project secret with different bytes.
    void backing.put({ ref: generationSecretRef(TOKEN_REF, 1), value: "xoxb-HACKED" });

    const verdict = await verifyBindingAppEnvProof(db, secrets, SCOPE, BIND);
    expect(verdict.status).toBe("hash_mismatch");
  });

  it("BLOCKS when the ready binding has no recorded generation (missing)", async () => {
    const { db, secrets } = await materialized();
    const verdict = await verifyBindingAppEnvProof(db, secrets, SCOPE, "bind_absent");
    expect(verdict.status).toBe("missing_generation");
  });

  it("BLOCKS when a scoped secret can no longer be resolved (unresolved_secret)", async () => {
    const { db, secrets, backing } = await materialized();
    await backing.delete(generationSecretRef(TOKEN_REF, 1));

    const verdict = await verifyBindingAppEnvProof(db, secrets, SCOPE, BIND);
    expect(verdict.status).toBe("unresolved_secret");
    if (verdict.status !== "unresolved_secret") return;
    expect(verdict.key).toBe("SLACK_BOT_TOKEN");
  });

  it("BLOCKS on an injected extra project_app_env row (output shape drift)", async () => {
    const { db, secrets } = await materialized();
    // Inject an env var not in the recorded output shape, under the same generation.
    db.appEnv.push({
      org_id: ORG,
      id: "injected",
      project_id: PROJECT,
      environment: "production",
      key: "INJECTED",
      value_ref: null,
      plain_value: "evil",
      scopes: ["runtime"],
      source: "provisioned",
      binding_id: BIND,
      binding_generation: 1,
      secret_generation: null,
      description: "",
    });

    const verdict = await verifyBindingAppEnvProof(db, secrets, SCOPE, BIND);
    expect(verdict.status).toBe("output_shape_mismatch");
  });

  it("BLOCKS a declared secret whose coordinate was dropped (output shape drift)", async () => {
    const { db, secrets } = await materialized();
    const token = db.appEnv.find((r) => r["key"] === "SLACK_BOT_TOKEN");
    token!["value_ref"] = null;
    token!["secret_generation"] = null;

    const verdict = await verifyBindingAppEnvProof(db, secrets, SCOPE, BIND);
    expect(verdict.status).toBe("output_shape_mismatch");
  });
});

describe("in-15 appEnvHash proof gate — project-wide assertion", () => {
  it("returns verified contracts for a clean project and is a no-op with no bindings", async () => {
    const { db, secrets } = await materialized();
    const verdicts = await verifyReadyProjectBindingProofs(db, secrets, SCOPE);
    expect(verdicts.map((v) => v.status)).toEqual(["verified"]);

    const contracts = await assertReadyProjectBindingProofs(db, secrets, SCOPE);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.bindingId).toBe(BIND);

    const empty = await assertReadyProjectBindingProofs(new BindingMaterializerMemoryDb(), secrets, SCOPE);
    expect(empty).toEqual([]);
  });

  it("THROWS BindingAppEnvProofFailedError when any ready binding fails the proof", async () => {
    const { db, secrets } = await materialized();
    db.appEnv.find((r) => r["key"] === "SLACK_CHANNEL_ID")!["plain_value"] = "C-HACKED";

    await expect(assertReadyProjectBindingProofs(db, secrets, SCOPE)).rejects.toBeInstanceOf(
      BindingAppEnvProofFailedError,
    );
  });
});
