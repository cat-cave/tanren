// Offline verifier for `integration-evidence.v1.dsse.json`. It deliberately
// reimplements the PgProofSubstrate digest chain and DSSE PAE verification with
// node:crypto; no stored `valid` field, database row, or network response is
// trusted.

import { createHash, createPublicKey, verify } from "node:crypto";

const VERSION = "integration-evidence.v1.dsse.json";
const PAYLOAD_TYPE = "application/vnd.tanren.integration-evidence.v1+json";
const LEAF_TAG = "tanren.proof-leaf.v1";
const NODE_TAG = "tanren.proof-node.v1";
const EMPTY_TAG = "tanren.proof-empty.v1";
const BUNDLE_TAG = "tanren.proof-bundle.v1";
const SEAL_TAG = "tanren.proof-bundle-seal.v1";

export type IntegrationEvidenceVerifyResult = {
  readonly valid: boolean;
  readonly structuralError: string | null;
  readonly failures: readonly string[];
  readonly recomputedProofRoot: string | null;
  readonly recomputedBundleDigest: string | null;
  readonly recomputedBytesDigest: string | null;
};

const INVALID = (structuralError: string): IntegrationEvidenceVerifyResult => ({
  valid: false,
  structuralError,
  failures: [],
  recomputedProofRoot: null,
  recomputedBundleDigest: null,
  recomputedBytesDigest: null,
});

/** Recompute every digest and both ed25519 signatures from the document bytes. */
export function verifyIntegrationEvidenceDocument(document: unknown): IntegrationEvidenceVerifyResult {
  try {
    if (!object(document)) return INVALID("evidence document is not an object");
    if (document["version"] !== VERSION) return INVALID(`unexpected evidence version: ${String(document["version"])}`);
    if (document["payloadType"] !== PAYLOAD_TYPE)
      return INVALID(`unexpected payload type: ${String(document["payloadType"])}`);
    if (!string(document["payload"]) || !Array.isArray(document["signatures"]) || !string(document["publicKeyPem"])) {
      return INVALID("evidence document is missing payload, signatures, or public key");
    }
    const payload = Buffer.from(document["payload"], "base64url");
    const payloadObject = parsePayload(payload);
    const bundle = document["bundle"];
    if (!object(bundle)) return INVALID("evidence document is missing proof bundle");
    const members = membersOf(bundle["members"]);
    const bindings = bindingsOf(bundle["bindings"]);
    if (members === undefined || bindings === undefined)
      return INVALID("proof bundle has malformed members or bindings");
    const orgId = payloadObject["orgId"];
    const projectId = payloadObject["projectId"];
    if (!string(orgId) || !string(projectId)) return INVALID("signed payload lacks org/project identity");
    const proofRoot = computeProofRoot(members);
    const bundleDigest = computeBundleDigest(proofRoot, members, bindings);
    const bundleId = bundle["bundleId"];
    const rootSignature = bundle["rootSignature"];
    const signingKeyId = bundle["signingKeyId"];
    if (!string(bundleId) || !string(rootSignature) || !string(signingKeyId))
      return INVALID("proof bundle lacks signed identity");
    const bytesDigest = contentDigest(
      canonicalBytes([
        "tanren.proof-bundle-bytes.v1",
        {
          bindings: canonicalBindings(bindings),
          bundleDigest: bundle["bundleDigest"],
          bundleId,
          members: [...members].sort((left, right) => left.ordinal - right.ordinal).map((member) => ({ ...member })),
          proofRoot: bundle["proofRoot"],
          rootSignature: Buffer.from(rootSignature, "base64url").toString("hex"),
          signingKeyId,
        },
      ]),
    );
    const failures: string[] = [];
    if (bundle["proofRoot"] !== proofRoot) failures.push("proof root does not recompute from ordered members");
    if (bundle["bundleDigest"] !== bundleDigest)
      failures.push("bundle digest does not recompute from proof root and bindings");
    if (bundle["bytesDigest"] !== bytesDigest) failures.push("bundle bytes digest does not recompute");
    if (!contiguousMembers(members, bundleId))
      failures.push("proof bundle members are not a contiguous, bound ordinal sequence");
    if (!bundleIdMatches(bundleId, orgId, projectId, bundleDigest))
      failures.push("bundle id does not bind signed org/project/digest");
    const publicKey = createPublicKey(document["publicKeyPem"]);
    const publicKeyId = `ed25519:${contentDigest(new Uint8Array(publicKey.export({ type: "spki", format: "der" }))).slice("sha256:".length)}`;
    if (publicKeyId !== signingKeyId) failures.push("public key fingerprint does not match bundle signing key id");
    const rootMessage = canonicalBytes([
      SEAL_TAG,
      orgId,
      projectId,
      bundleDigest,
      proofRoot,
      canonicalBindings(bindings),
    ]);
    if (!verify(null, rootMessage, publicKey, Buffer.from(rootSignature, "base64url"))) {
      failures.push("ed25519 proof-bundle signature does not verify");
    }
    const signature = document["signatures"][0];
    if (!object(signature) || !string(signature["keyid"]) || !string(signature["sig"])) {
      failures.push("DSSE signature is malformed");
    } else {
      if (signature["keyid"] !== signingKeyId) failures.push("DSSE key id does not match proof bundle signing key id");
      if (!verify(null, dssePae(PAYLOAD_TYPE, payload), publicKey, Buffer.from(signature["sig"], "base64url"))) {
        failures.push("ed25519 DSSE signature does not verify");
      }
    }
    return {
      valid: failures.length === 0,
      structuralError: null,
      failures,
      recomputedProofRoot: proofRoot,
      recomputedBundleDigest: bundleDigest,
      recomputedBytesDigest: bytesDigest,
    };
  } catch (error) {
    return INVALID(
      `evidence verification could not parse document: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parsePayload(payload: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
  if (!object(parsed)) throw new Error("DSSE payload is not an object");
  if (canonicalJson(parsed) !== Buffer.from(payload).toString("utf8"))
    throw new Error("DSSE payload is not canonical JSON");
  return parsed;
}

type Member = {
  readonly bundleUnitId: string;
  readonly unitDigest: string;
  readonly kind: string;
  readonly verdict: string;
  readonly ordinal: number;
};

function membersOf(value: unknown): readonly Member[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const members: Member[] = [];
  for (const raw of value) {
    if (
      !object(raw) ||
      !string(raw["bundleUnitId"]) ||
      !string(raw["unitDigest"]) ||
      !string(raw["kind"]) ||
      !string(raw["verdict"])
    ) {
      return undefined;
    }
    if (!Number.isInteger(raw["ordinal"]) || (raw["ordinal"] as number) < 0) return undefined;
    members.push({
      bundleUnitId: raw["bundleUnitId"],
      unitDigest: raw["unitDigest"],
      kind: raw["kind"],
      verdict: raw["verdict"],
      ordinal: raw["ordinal"] as number,
    });
  }
  return members;
}

function bindingsOf(value: unknown): Record<string, string> | undefined {
  if (!object(value)) return undefined;
  const keys = [
    "integrationNodeId",
    "memberSetHash",
    "preparedHeadSha",
    "jjTreeId",
    "artifactDigest",
    "expectedMainSha",
    "issuedAt",
    "expiresAt",
    "nonce",
  ];
  if (keys.some((key) => !string(value[key]))) return undefined;
  return Object.fromEntries(keys.map((key) => [key, value[key] as string]));
}

function computeProofRoot(members: readonly Member[]): string {
  if (members.length === 0) return contentDigest(canonicalBytes([EMPTY_TAG]));
  const ordered = [...members].sort((left, right) => left.ordinal - right.ordinal);
  let level = ordered.map((member, ordinal) =>
    contentDigest(canonicalBytes([LEAF_TAG, ordinal, member.unitDigest, member.kind, member.verdict])),
  );
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1];
      next.push(right === undefined ? left : contentDigest(canonicalBytes([NODE_TAG, left, right])));
    }
    level = next;
  }
  return level[0]!;
}

function computeBundleDigest(proofRoot: string, members: readonly Member[], bindings: Record<string, string>): string {
  const ordered = [...members]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((member) => ({
      kind: member.kind,
      ordinal: member.ordinal,
      unitDigest: member.unitDigest,
      verdict: member.verdict,
    }));
  return contentDigest(canonicalBytes([BUNDLE_TAG, proofRoot, ordered, canonicalBindings(bindings)]));
}

function canonicalBindings(bindings: Record<string, string>): Record<string, string> {
  return {
    artifactDigest: bindings["artifactDigest"]!,
    expectedMainSha: bindings["expectedMainSha"]!,
    expiresAt: bindings["expiresAt"]!,
    integrationNodeId: bindings["integrationNodeId"]!,
    issuedAt: bindings["issuedAt"]!,
    jjTreeId: bindings["jjTreeId"]!,
    memberSetHash: bindings["memberSetHash"]!,
    nonce: bindings["nonce"]!,
    preparedHeadSha: bindings["preparedHeadSha"]!,
  };
}

function contiguousMembers(members: readonly Member[], bundleId: string): boolean {
  const ordered = [...members].sort((left, right) => left.ordinal - right.ordinal);
  return (
    new Set(ordered.map((member) => member.unitDigest)).size === ordered.length &&
    ordered.every((member, index) => member.ordinal === index && member.bundleUnitId === `${bundleId}.u${index}`)
  );
}

function bundleIdMatches(bundleId: string, orgId: string, projectId: string, bundleDigest: string): boolean {
  if (!bundleId.startsWith("pb1_")) return false;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(bundleId.slice(4), "base64url").toString("utf8"));
    return (
      object(decoded) &&
      decoded["o"] === orgId &&
      decoded["p"] === projectId &&
      decoded["d"] === bundleDigest &&
      `pb1_${Buffer.from(canonicalJson({ d: bundleDigest, o: orgId, p: projectId }), "utf8").toString("base64url")}` ===
        bundleId
    );
  } catch {
    return false;
  }
}

function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const type = new TextEncoder().encode(payloadType);
  const prefix = new TextEncoder().encode(`DSSEv1 ${String(type.byteLength)} `);
  const middle = new TextEncoder().encode(` ${String(payload.byteLength)} `);
  return Buffer.concat([prefix, type, middle, payload]);
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function contentDigest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (!object(value)) throw new TypeError("canonical JSON cannot encode this value");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
