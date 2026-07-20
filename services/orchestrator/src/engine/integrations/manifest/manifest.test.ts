import { describe, expect, it } from "vitest";

import { renderContractJsonSchema } from "../../schemaExport/catalog.js";
import {
  resolveIntegrationFragments,
  type IntegrationFragmentDraft,
  type IntegrationFragmentSpec,
  type ValidatedIntegrationFragment,
} from "../fragments/index.js";
import { validateIntegrationFragment } from "../fragments/model.js";
import type { IntegrationFragmentPersistenceStore } from "../fragments/store.js";
import {
  IntegrationsManifestInvalidError,
  IntegrationsManifestV1Schema,
  integrationFragmentConfigFromManifest,
  manifestEntryIdentity,
  resolveIntegrationsManifest,
} from "./index.js";

// A valid `.tanren/integrations.yml` — one product messaging integration.
const VALID_MANIFEST = `apiVersion: tanren.dev/integrations/v1
version: 1
integrations:
  - name: product-slack
    capability: messaging.send
    provider: slack
    providerVersion: 1.0.0
    plane: product
    direction: outbound
    environments:
      - test
      - production
    operations:
      - chat.postMessage
      - conversations.history
    scopes:
      - chat:write
      - channels:history
    criticality: release_required
    providerPolicy:
      preferred:
        - slack
      allowed:
        - slack
`;

function draftFor(spec: IntegrationFragmentSpec): IntegrationFragmentDraft {
  const bindingKind = spec.plane === "product" ? "product.messaging.bot_token_ref" : "control.notify.bot_token_ref";
  return {
    spec,
    definition: {
      direction: "outbound",
      criticality: "release_required",
      bindingOutputs: [
        { kind: bindingKind, logicalKey: "PROVIDER_TOKEN", classification: "secret_ref", required: true },
      ],
      operations: ["chat.postMessage"],
      validationPlan: {
        version: 1,
        preMerge: { contractTests: true, recordingFake: true, negativeControls: true, liveProviderInMergeGate: false },
        postDeploy: { liveStimulus: true, independentObservation: true },
        negativeControls: ["missing-scope"],
      },
    },
  };
}

function fragmentId(f: ValidatedIntegrationFragment): string {
  return `${f.draft.spec.capability}:${f.draft.spec.providerKind}@${f.draft.spec.version}`;
}

function memoryStore(seed: readonly ValidatedIntegrationFragment[] = []): IntegrationFragmentPersistenceStore {
  let rows = [...seed];
  return {
    async createValidated(input) {
      rows = [...rows, input.fragment];
      return { persistedId: fragmentId(input.fragment) };
    },
    async deleteById(_orgId, persistedId) {
      rows = rows.filter((row) => fragmentId(row) !== persistedId);
    },
    async listValidated() {
      return rows;
    },
  };
}

describe("in-8 .tanren/integrations.yml manifest — parse + validate (fail-closed)", () => {
  it("parses a valid manifest into the typed shape", () => {
    const manifest = resolveIntegrationsManifest(VALID_MANIFEST);
    expect(manifest).toBeDefined();
    expect(manifest?.apiVersion).toBe("tanren.dev/integrations/v1");
    expect(manifest?.integrations).toHaveLength(1);
    const entry = manifest?.integrations[0];
    expect(entry).toMatchObject({
      name: "product-slack",
      capability: "messaging.send",
      provider: "slack",
      providerVersion: "1.0.0",
      plane: "product",
      direction: "outbound",
      environments: ["test", "production"],
      operations: ["chat.postMessage", "conversations.history"],
      scopes: ["chat:write", "channels:history"],
      criticality: "release_required",
    });
    expect(entry?.providerPolicy).toEqual({ preferred: ["slack"], allowed: ["slack"] });
    expect(manifestEntryIdentity(entry!)).toBe("messaging.send:slack@1.0.0");
  });

  it("treats an ABSENT file (undefined text) as no declared integrations — undefined, not an error", () => {
    const absent: string | undefined = undefined;
    expect(resolveIntegrationsManifest(absent)).toBeUndefined();
  });

  it("rejects a PRESENT-but-empty (comment-only) document loudly", () => {
    expect(() => resolveIntegrationsManifest("# nothing declared\n")).toThrow(IntegrationsManifestInvalidError);
  });

  it("rejects malformed YAML with a typed error carrying a line-scoped issue (no ci.yml label leak)", () => {
    const err = captureInvalid("apiVersion: tanren.dev/integrations/v1\n\tversion: 1\n");
    expect(err.issues.length).toBeGreaterThan(0);
    expect(err.issues[0]?.path).toMatch(/^line \d+$/u);
    expect(err.issues[0]?.message).not.toMatch(/tanren-ci\.yml/u);
  });

  it("rejects an unknown/mistyped field (strict) as a typed error", () => {
    const withUnknown = VALID_MANIFEST.replace(
      "    capability: messaging.send",
      "    capability: messaging.send\n    surprise: 1",
    );
    expect(() => resolveIntegrationsManifest(withUnknown)).toThrow(IntegrationsManifestInvalidError);
  });

  it("rejects a missing required field (no provider) as a typed error", () => {
    const withoutProvider = VALID_MANIFEST.replace("    provider: slack\n", "");
    const err = captureInvalid(withoutProvider);
    expect(err.issues.some((i) => i.path.includes("provider"))).toBe(true);
  });

  it("rejects a malformed capability (uppercase) as a typed error", () => {
    const badCapability = VALID_MANIFEST.replace("capability: messaging.send", "capability: Messaging.Send");
    expect(() => resolveIntegrationsManifest(badCapability)).toThrow(IntegrationsManifestInvalidError);
  });

  it("rejects a plane/capability mismatch (a control capability declared on the product plane)", () => {
    const mismatch = VALID_MANIFEST.replace("capability: messaging.send", "capability: control.notify").replace(
      "provider: slack",
      "provider: slack",
    );
    const err = captureInvalid(mismatch);
    expect(err.issues.some((i) => i.message.includes("requires plane"))).toBe(true);
  });

  it("rejects a duplicate integration name", () => {
    const dup = twoEntryManifest({ secondName: "product-slack", secondProvider: "sentry" });
    const err = captureInvalid(dup);
    expect(err.issues.some((i) => i.message.includes("duplicate integration name"))).toBe(true);
  });

  it("rejects a duplicate (capability, provider, version) identity", () => {
    const dup = twoEntryManifest({ secondName: "other-slack", secondProvider: "slack" });
    const err = captureInvalid(dup);
    expect(err.issues.some((i) => i.message.includes("duplicate integration identity"))).toBe(true);
  });

  it("rejects a provider policy that forbids the entry's own provider", () => {
    const selfForbid = VALID_MANIFEST.replace(
      "      allowed:\n        - slack\n",
      "      allowed:\n        - slack\n      forbidden:\n        - slack\n",
    );
    const err = captureInvalid(selfForbid);
    expect(err.issues.some((i) => i.message.includes("forbids the entry's own provider"))).toBe(true);
  });
});

describe("in-8 manifest → in-7 derive-path projection (production wiring)", () => {
  it("projects the manifest onto the in-7 IntegrationFragmentConfig the derive seam consumes", () => {
    const manifest = resolveIntegrationsManifest(VALID_MANIFEST)!;
    const config = integrationFragmentConfigFromManifest(manifest);
    expect(config).toEqual({
      apiVersion: "tanren.dev/integration-fragments/v1",
      schemaVersion: 1,
      fragments: [{ capability: "messaging.send", providerKind: "slack", plane: "product", version: "1.0.0" }],
    });
  });

  it("feeds the projected config into resolveIntegrationFragments and composes the registered definition", async () => {
    const manifest = resolveIntegrationsManifest(VALID_MANIFEST)!;
    const config = integrationFragmentConfigFromManifest(manifest);
    const spec = config.fragments[0]!;
    const store = memoryStore([validateIntegrationFragment(draftFor(spec))]);

    const composed = await resolveIntegrationFragments({
      config,
      context: { orgId: "org-in8", projectId: "project-in8", createdBy: "operator-in8" },
      store,
      eventStore: { async append() {} },
    });

    expect(composed.snapshot).toHaveLength(1);
    expect(composed.snapshot[0]).toMatchObject({
      capability: "messaging.send",
      providerKind: "slack",
      version: "1.0.0",
    });
  });
});

describe("in-8 manifest JSON Schema artifact matches the Zod contract", () => {
  it("renders a draft-2020-12 JSON Schema whose required top-level fields mirror the Zod object", () => {
    const jsonSchema = renderContractJsonSchema(IntegrationsManifestV1Schema);
    expect(jsonSchema["type"]).toBe("object");
    expect(jsonSchema["required"]).toEqual(expect.arrayContaining(["apiVersion", "version", "integrations"]));
    expect(jsonSchema["additionalProperties"]).toBe(false);
  });
});

function captureInvalid(yamlText: string): IntegrationsManifestInvalidError {
  try {
    resolveIntegrationsManifest(yamlText);
  } catch (error) {
    if (error instanceof IntegrationsManifestInvalidError) return error;
    throw error;
  }
  throw new Error("expected IntegrationsManifestInvalidError");
}

function twoEntryManifest(opts: { secondName: string; secondProvider: string }): string {
  return `${VALID_MANIFEST}  - name: ${opts.secondName}
    capability: messaging.send
    provider: ${opts.secondProvider}
    providerVersion: 1.0.0
    plane: product
    direction: outbound
    environments:
      - production
    operations:
      - chat.postMessage
    scopes:
      - chat:write
    criticality: best_effort
`;
}
