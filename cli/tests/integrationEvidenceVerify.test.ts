import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyIntegrationEvidenceDocument } from "../src/commands/integrations/verifyEvidence.js";

const PAYLOAD_TYPE = "application/vnd.tanren.integration-evidence.v1+json";
const LEAF_TAG = "tanren.proof-leaf.v1";
const BUNDLE_TAG = "tanren.proof-bundle.v1";
const SEAL_TAG = "tanren.proof-bundle-seal.v1";

function document(): Record<string, unknown> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const orgId = "org-cli-evidence";
  const projectId = "project-cli-evidence";
  const member = {
    bundleUnitId: "",
    unitDigest: `sha256:${"a".repeat(64)}`,
    kind: "runtime_behavior",
    verdict: "passed",
    ordinal: 0,
  };
  const bindings = {
    integrationNodeId: "integration-evidence:delivery-cli",
    memberSetHash: member.unitDigest,
    preparedHeadSha: "a".repeat(40),
    jjTreeId: "a".repeat(40),
    artifactDigest: member.unitDigest,
    expectedMainSha: "a".repeat(40),
    issuedAt: "2026-07-21T00:00:00.000Z",
    expiresAt: "2026-07-21T00:00:00.000Z",
    nonce: "a3:delivery-cli:binding-cli:1",
  };
  const proofRoot = digest(bytes([LEAF_TAG, 0, member.unitDigest, member.kind, member.verdict]));
  const bundleDigest = digest(
    bytes([
      BUNDLE_TAG,
      proofRoot,
      [{ kind: member.kind, ordinal: 0, unitDigest: member.unitDigest, verdict: member.verdict }],
      bindings,
    ]),
  );
  const bundleId = `pb1_${Buffer.from(canonical({ d: bundleDigest, o: orgId, p: projectId }), "utf8").toString("base64url")}`;
  member.bundleUnitId = `${bundleId}.u0`;
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signingKeyId = `ed25519:${digest(new Uint8Array(publicKey.export({ type: "spki", format: "der" }))).slice("sha256:".length)}`;
  const rootSignature = sign(null, bytes([SEAL_TAG, orgId, projectId, bundleDigest, proofRoot, bindings]), privateKey);
  const bytesDigest = digest(
    bytes([
      "tanren.proof-bundle-bytes.v1",
      {
        bindings,
        bundleDigest,
        bundleId,
        members: [member],
        proofRoot,
        rootSignature: rootSignature.toString("hex"),
        signingKeyId,
      },
    ]),
  );
  const payload = bytes({ orgId, projectId, version: "integration-evidence.v1.dsse.json" });
  const dsseSignature = sign(null, dssePae(PAYLOAD_TYPE, payload), privateKey);
  return {
    version: "integration-evidence.v1.dsse.json",
    payloadType: PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64url"),
    signatures: [{ keyid: signingKeyId, sig: dsseSignature.toString("base64url") }],
    publicKeyPem,
    bundle: {
      bundleId,
      bundleDigest,
      proofRoot,
      bytesDigest,
      signingKeyId,
      rootSignature: rootSignature.toString("base64url"),
      members: [member],
      bindings,
    },
  };
}

describe("tanren integrations verify-evidence", () => {
  it("recomputes a valid DSSE + proof-bundle digest chain", () => {
    expect(verifyIntegrationEvidenceDocument(document()).valid).toBe(true);
  });

  it("DECISIVE: a tampered DSSE payload fails recomputation and signature verification", () => {
    const tampered = document();
    tampered["payload"] = Buffer.from(
      canonical({ orgId: "other-org", projectId: "project-cli-evidence" }),
      "utf8",
    ).toString("base64url");
    const result = verifyIntegrationEvidenceDocument(tampered);
    expect(result.valid).toBe(false);
    expect(result.failures.join(" ")).toMatch(/bundle id|DSSE/u);
  });
});

function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const type = new TextEncoder().encode(payloadType);
  return Buffer.concat([
    new TextEncoder().encode(`DSSEv1 ${String(type.byteLength)} `),
    type,
    new TextEncoder().encode(` ${String(payload.byteLength)} `),
    payload,
  ]);
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonical(value));
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("unsupported canonical test value");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
