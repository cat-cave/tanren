// in-2: golden vectors for IntegrationRequirementV1 plane separation + digests.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contentDigestOf } from "../src/engine/contracts/cas.js";
import {
  canonicalRequirementBytes,
  goldenControlNotifyRequirement,
  goldenCrossPlaneForbiddenRequirement,
  goldenProductMessagingRequirement,
  integrationRequirementDigest,
  parseIntegrationRequirement,
} from "../src/engine/contracts/integrationRequirement.js";

/**
 * R4.4 — PINNED full-hex golden vectors. These are frozen bit-stability pins:
 * any change to canonical form, set ordering, domain tag, or the SP-3 serializer
 * must surface here as an intentional update. Content digest = sha256 of the
 * canonical stored bytes (CAS content-addressing); requirementDigest =
 * domainHash([tag, body]) — deliberately a different identity.
 */
const PRODUCT_REQUIREMENT_DIGEST = "sha256:bbadeeb0579acd907ef6662b2de9c3c67dc13b4816db2a293395194e3efb3393";
const PRODUCT_CONTENT_DIGEST = "sha256:2ffd4cbd340ae13516ba13cd1c5ac9927c28fa2294eff2c57a197aab363529ba";
const PRODUCT_BYTE_LENGTH = 1429;

const CONTROL_REQUIREMENT_DIGEST = "sha256:758498a8ce90c94ee192eaf6f82ab49df194f483d6fb9fe3e48f82ac407d77fa";
const CONTROL_CONTENT_DIGEST = "sha256:e816a42d3d2b109ffb5d7dc958dc94aa150c0dab476fe9c4e03446da93728af8";
const CONTROL_BYTE_LENGTH = 1120;

describe("IntegrationRequirementV1 golden vectors (in-2)", () => {
  it("accepts product messaging.send with product binding kinds", () => {
    const result = parseIntegrationRequirement(goldenProductMessagingRequirement());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement.plane).toBe("product");
    expect(result.requirement.capability).toBe("messaging.send");
    const digest = integrationRequirementDigest(result.requirement);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Stable digest across calls.
    expect(integrationRequirementDigest(result.requirement)).toBe(digest);
  });

  it("accepts control control.notify with control binding kinds", () => {
    const result = parseIntegrationRequirement(goldenControlNotifyRequirement());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement.plane).toBe("control");
    expect(result.requirement.bindingOutputs.every((o) => o.kind.startsWith("control."))).toBe(true);
  });

  it("rejects control credential shape claimed as product messaging (wrong-plane Slack)", () => {
    const result = parseIntegrationRequirement(goldenCrossPlaneForbiddenRequirement());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(["binding_plane_mismatch", "control_credential_as_product_messaging"]),
    );
  });

  it("rejects forbidden provider that is also preferred", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({
      ...base,
      providerPolicy: { preferred: ["slack"], allowed: ["slack"], forbidden: ["slack"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "provider_preferred_forbidden")).toBe(true);
  });

  it("rejects missing expected effect (schema)", () => {
    const base = goldenProductMessagingRequirement() as Record<string, unknown>;
    delete base.expectedEffect;
    const result = parseIntegrationRequirement(base);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "schema")).toBe(true);
  });

  it("rejects empty requiredScopes (schema)", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({ ...base, requiredScopes: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects capability/plane mismatch (messaging.send on control)", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({
      ...base,
      plane: "control",
      expectedEffect: { ...base.expectedEffect, plane: "control" },
      bindingOutputs: goldenControlNotifyRequirement().bindingOutputs,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "plane_capability_mismatch")).toBe(true);
  });

  it("rejects secret-shaped values in free text", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({
      ...base,
      trigger: {
        ...base.trigger,
        description: "token xoxb-1234567890-abcdefghijklmnop embedded",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "secret_value_forbidden")).toBe(true);
  });

  it("product and control digests differ", () => {
    const product = parseIntegrationRequirement(goldenProductMessagingRequirement());
    const control = parseIntegrationRequirement(goldenControlNotifyRequirement());
    expect(product.ok && control.ok).toBe(true);
    if (!product.ok || !control.ok) return;
    expect(integrationRequirementDigest(product.requirement)).not.toBe(
      integrationRequirementDigest(control.requirement),
    );
  });

  // ---- R4.4: pinned full-hex golden digests + byte lengths ----

  it("pins product golden requirementDigest + content digest + byte length", () => {
    const result = parseIntegrationRequirement(goldenProductMessagingRequirement());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(integrationRequirementDigest(result.requirement)).toBe(PRODUCT_REQUIREMENT_DIGEST);
    const bytes = canonicalRequirementBytes(result.requirement);
    expect(bytes.byteLength).toBe(PRODUCT_BYTE_LENGTH);
    expect(contentDigestOf(bytes)).toBe(PRODUCT_CONTENT_DIGEST);
    // domain-vs-content separation is deliberate: the two identities MUST differ.
    expect(PRODUCT_REQUIREMENT_DIGEST).not.toBe(PRODUCT_CONTENT_DIGEST);
  });

  it("pins control golden requirementDigest + content digest + byte length", () => {
    const result = parseIntegrationRequirement(goldenControlNotifyRequirement());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(integrationRequirementDigest(result.requirement)).toBe(CONTROL_REQUIREMENT_DIGEST);
    const bytes = canonicalRequirementBytes(result.requirement);
    expect(bytes.byteLength).toBe(CONTROL_BYTE_LENGTH);
    expect(contentDigestOf(bytes)).toBe(CONTROL_CONTENT_DIGEST);
    expect(CONTROL_REQUIREMENT_DIGEST).not.toBe(CONTROL_CONTENT_DIGEST);
  });

  // ---- R4.2: set-semantic canonicalization (permutation / duplicate stability) ----

  it("environments permutation does not change the requirement digest", () => {
    const base = goldenProductMessagingRequirement();
    const reversed = { ...base, environments: ["production", "test"] };
    const canonical = parseIntegrationRequirement(base);
    const permuted = parseIntegrationRequirement(reversed);
    expect(canonical.ok && permuted.ok).toBe(true);
    if (!canonical.ok || !permuted.ok) return;
    expect(integrationRequirementDigest(permuted.requirement)).toBe(
      integrationRequirementDigest(canonical.requirement),
    );
  });

  it("requiredOperations permutation does not change the requirement digest", () => {
    const base = goldenProductMessagingRequirement();
    const reordered = { ...base, requiredOperations: ["conversations.history", "chat.postMessage"] };
    const a = parseIntegrationRequirement(base);
    const b = parseIntegrationRequirement(reordered);
    if (!a.ok || !b.ok) throw new Error("parse failed");
    expect(integrationRequirementDigest(b.requirement)).toBe(integrationRequirementDigest(a.requirement));
  });

  it("requiredScopes duplicate collapse keeps the same digest (set semantics)", () => {
    const base = goldenProductMessagingRequirement();
    const deduped = { ...base, requiredScopes: ["chat:write", "channels:history", "chat:write"] };
    const a = parseIntegrationRequirement(base);
    const b = parseIntegrationRequirement(deduped);
    if (!a.ok || !b.ok) throw new Error("parse failed");
    expect(integrationRequirementDigest(b.requirement)).toBe(integrationRequirementDigest(a.requirement));
    // Stored canonical bytes collapse the duplicate too.
    expect(canonicalRequirementBytes(b.requirement).byteLength).toBe(PRODUCT_BYTE_LENGTH);
  });

  it("canonicalization does not mutate caller input", () => {
    const base = goldenProductMessagingRequirement();
    const original = [...base.environments];
    const result = parseIntegrationRequirement(base);
    if (!result.ok) throw new Error("parse failed");
    integrationRequirementDigest(result.requirement);
    canonicalRequirementBytes(result.requirement);
    // Caller's array ordering is untouched.
    expect(base.environments).toEqual(original);
  });

  // ---- R4.1: secret_ref tightening ----

  it("rejects secret_ref classification on a bare _id kind (channel_id)", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({
      ...base,
      bindingOutputs: [
        {
          version: 1,
          kind: "product.messaging.channel_id",
          logicalKey: "SLACK_PRODUCT_CHANNEL_ID",
          classification: "secret_ref",
          required: true,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "secret_ref_kind_mismatch")).toBe(true);
  });

  it("accepts secret_ref on an explicitly ref-shaped kind (ends in _ref)", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({
      ...base,
      bindingOutputs: [
        {
          version: 1,
          kind: "product.messaging.bot_token_ref",
          logicalKey: "SLACK_BOT_TOKEN_REF",
          classification: "secret_ref",
          required: true,
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  // ---- R4.4: strict version + extra-field coverage ----

  it("rejects version 2 (strict version literal)", () => {
    const base = goldenProductMessagingRequirement() as Record<string, unknown>;
    const result = parseIntegrationRequirement({ ...base, version: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "schema")).toBe(true);
  });

  it("rejects unknown top-level field (strict)", () => {
    const base = goldenProductMessagingRequirement() as Record<string, unknown>;
    const result = parseIntegrationRequirement({ ...base, unexpectedField: "boom" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "schema")).toBe(true);
  });
});

// ---- R2 follow-up: content-digest authority ----
// There must be exactly ONE bytes→Digest helper — `contentDigestOf` in
// engine/contracts/cas.ts — reused by the CAS byte store and the validate route.
// A second copy would let an algorithm drift silently split content identity (the
// R2 root defect: the route and PgCas each carried their own SHA-256). Pinned by
// reading the real source files, the same file-inventory style as the runner image
// guards. Co-located with the golden digest pins because this is the digest-authority
// contract: one implementation of each framing, reused everywhere.
const casSource = readFileSync(fileURLToPath(new URL("../src/engine/contracts/cas.ts", import.meta.url)), "utf8");
const pgCasSource = readFileSync(
  fileURLToPath(new URL("../src/engine/cas/pgCasByteStore.ts", import.meta.url)),
  "utf8",
);
const routeSource = readFileSync(
  fileURLToPath(new URL("../src/routes/integrationContracts/index.ts", import.meta.url)),
  "utf8",
);

describe("in-2 R2 — content-digest authority (one bytes→Digest helper)", () => {
  it("engine/contracts/cas.ts exports the canonical contentDigestOf helper", () => {
    expect(casSource).toContain("export function contentDigestOf");
  });

  it("PgCasByteStore reuses the canonical helper and owns no SHA-256 implementation", () => {
    // No local crypto import, no hand-rolled hash function of any name (the /i
    // flag covers both `digestOf` and `contentDigestOf` style local definitions).
    expect(pgCasSource).not.toContain("createHash");
    expect(pgCasSource).not.toMatch(/function\s+\w*digest\w*\s*\(/iu);
    // The canonical helper is imported and used.
    expect(pgCasSource).toContain("contentDigestOf");
  });

  it("validate route reuses the canonical helper and owns no SHA-256 implementation", () => {
    expect(routeSource).not.toContain("createHash");
    expect(routeSource).not.toMatch(/function\s+\w*digest\w*\s*\(/iu);
    expect(routeSource).toContain("contentDigestOf");
  });
});
