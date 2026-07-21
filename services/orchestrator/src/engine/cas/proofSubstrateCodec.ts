/**
 * SP-3 ProofSubstrate — the DETERMINISTIC, DB-free, key-free security core.
 *
 * This is the byte-stable heart of the sole proof substrate: the canonical
 * Merkle root over a bundle's member units, the canonical message that gets
 * ed25519-signed, the whole-bundle content digest, the persisted-bytes
 * serialization, and the org/project-carrying bundle id codec. It performs NO
 * signing, NO DB, and NO wall-clock reads — every function here is a pure,
 * reproducible transform so `verify` can independently re-derive exactly what
 * `constructBundle`/`seal` produced. All content hashing routes through the SOLE
 * `contentDigestOf` bytes→identity helper (never a re-rolled SHA-256), so the CAS
 * digest authority stays singular.
 *
 * CANONICAL MEMBER ORDER: the input array order IS canonical — member `ordinal`
 * is its index. The Merkle leaf binds that ordinal, so the root is
 * ORDER-SENSITIVE: reordering the members yields a DIFFERENT root, which no
 * longer matches the sealed signature and is therefore rejected by `verify`.
 * Identical members in identical order always yield the identical root.
 */

import type {
  BundleBindings,
  CanonicalBody,
  Digest,
  ProofBundleMemberRef,
  ProofUnitKind,
  ProofUnitRef,
  ProofUnitVerdict,
} from "../contracts/cas.js";
import { canonicalJson, contentDigestOf } from "../contracts/cas.js";

/** The ordinal-bound member shape the whole-bundle digest hashes over (no bundle-row id). */
export interface OrdinalMember {
  readonly unitDigest: Digest;
  readonly kind: ProofUnitKind;
  readonly verdict: ProofUnitVerdict;
  readonly ordinal: number;
}

/** Domain-separation tags — distinct framings so a leaf can never be reinterpreted as a node. */
const LEAF_TAG = "tanren.proof-leaf.v1";
const NODE_TAG = "tanren.proof-node.v1";
const EMPTY_TAG = "tanren.proof-empty.v1";
const SEAL_TAG = "tanren.proof-bundle-seal.v1";
const BUNDLE_TAG = "tanren.proof-bundle.v1";

const encoder = new TextEncoder();

/** UTF-8 bytes of the canonical JSON serialization of a canonical body. */
function canonicalBytes(value: CanonicalBody): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

/** The domain-separated Merkle LEAF digest for one member at a fixed ordinal. */
function leafDigest(ordinal: number, ref: ProofUnitRef): Digest {
  return contentDigestOf(canonicalBytes([LEAF_TAG, ordinal, ref.digest, ref.kind, ref.verdict]));
}

/** The domain-separated Merkle INTERNAL-NODE digest over two child digests. */
function nodeDigest(left: Digest, right: Digest): Digest {
  return contentDigestOf(canonicalBytes([NODE_TAG, left, right]));
}

/**
 * The canonical, deterministic Merkle root over the member units. Pure: identical
 * input (same members, same order) ⇒ identical root. The leaf binds the ordinal
 * (input index), so any reorder changes the root. An odd node at a level is
 * promoted unchanged to the next level (deterministic; no self-pairing). An empty
 * member set has a fixed, well-defined empty-tree root — real bundles reject it
 * upstream, but the function stays total for `verify`.
 */
export function computeProofRoot(members: readonly ProofUnitRef[]): Digest {
  if (members.length === 0) {
    return contentDigestOf(canonicalBytes([EMPTY_TAG]));
  }
  let level: Digest[] = members.map((ref, index) => leafDigest(index, ref));
  while (level.length > 1) {
    const next: Digest[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : nodeDigest(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/** Canonicalize `BundleBindings` into a key-sorted canonical body (all string fields). */
export function canonicalBindings(bindings: BundleBindings): CanonicalBody {
  return {
    ...(bindings.appEnvHash === undefined ? {} : { appEnvHash: bindings.appEnvHash }),
    artifactDigest: bindings.artifactDigest,
    expectedMainSha: bindings.expectedMainSha,
    expiresAt: bindings.expiresAt,
    ...(bindings.gateConfigHash === undefined ? {} : { gateConfigHash: bindings.gateConfigHash }),
    integrationNodeId: bindings.integrationNodeId,
    issuedAt: bindings.issuedAt,
    jjTreeId: bindings.jjTreeId,
    memberSetHash: bindings.memberSetHash,
    nonce: bindings.nonce,
    ...(bindings.policyVersion === undefined ? {} : { policyVersion: bindings.policyVersion }),
    preparedHeadSha: bindings.preparedHeadSha,
    ...(bindings.quarantineVersion === undefined ? {} : { quarantineVersion: bindings.quarantineVersion }),
    ...(bindings.runnerImage === undefined ? {} : { runnerImage: bindings.runnerImage }),
  };
}

/**
 * The exact byte message that `seal` signs and `verify` re-checks: a
 * domain-tagged, canonical serialization of the FULL bundle identity —
 * (orgId ‖ projectId ‖ bundleDigest ‖ proofRoot ‖ canonical-bindings). The tenant
 * (`orgId`/`projectId`) and bundle identity (`bundleDigest`) are INSIDE the signed
 * envelope, so a proof cannot be rebound to another org/project or another bundle
 * identity without re-signing (which needs the private key). `bundleDigest` already
 * binds proofRoot + members + bindings; proofRoot + bindings are also signed
 * explicitly (defense in depth). Byte-stable — no map iteration order, no
 * timestamps beyond the durable binding fields the caller already fixed.
 */
export function canonicalSealMessage(input: {
  readonly orgId: string;
  readonly projectId: string;
  readonly bundleDigest: Digest;
  readonly proofRoot: Digest;
  readonly bindings: BundleBindings;
}): Uint8Array {
  return canonicalBytes([
    SEAL_TAG,
    input.orgId,
    input.projectId,
    input.bundleDigest,
    input.proofRoot,
    canonicalBindings(input.bindings),
  ]);
}

/**
 * The canonical bytes content-addressed for a proof unit. The content identity
 * binds `kind` + `verdict` + `body`, so two units with the same body but a
 * different kind/verdict get DISTINCT `proof_unit_digest`s (no first-writer-wins
 * `ON CONFLICT` collision in `proof_units`) — matching the sealed member leaf's
 * kind/verdict binding. Domain-tagged so it can never collide with a bare body hash.
 */
export function proofUnitContentBytes(unit: {
  readonly kind: ProofUnitKind;
  readonly verdict: ProofUnitVerdict;
  readonly body: CanonicalBody;
}): Uint8Array {
  return canonicalBytes(["tanren.proof-unit.v1", unit.kind, unit.verdict, unit.body]);
}

/** The ordinal-ordered canonical projection of a member for the whole-bundle digest. */
function canonicalMember(member: OrdinalMember): CanonicalBody {
  return {
    kind: member.kind,
    ordinal: member.ordinal,
    unitDigest: member.unitDigest,
    verdict: member.verdict,
  };
}

/**
 * The canonical content hash of the WHOLE bundle's sealed-over semantic identity
 * (proofRoot + ordinal-ordered members + bindings) — signature-independent, so it
 * is stable regardless of which key signed. Members are sorted by ordinal so the
 * digest never depends on incoming array order of the member-ref list.
 */
export function computeBundleDigest(input: {
  readonly proofRoot: Digest;
  readonly members: readonly OrdinalMember[];
  readonly bindings: BundleBindings;
}): Digest {
  const orderedMembers = [...input.members]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((member) => canonicalMember(member));
  return contentDigestOf(
    canonicalBytes([BUNDLE_TAG, input.proofRoot, orderedMembers, canonicalBindings(input.bindings)]),
  );
}

/**
 * The canonical bytes persisted to the CAS and bound by `bytesDigest`: the full
 * sealed manifest INCLUDING the signing key id and (hex-encoded) signature.
 * ed25519 signatures are deterministic (RFC 8032), so this serialization is fully
 * reproducible — `verify` re-serializes and re-hashes to catch any tamper of the
 * stored bytes.
 */
export function serializeBundleBytes(bundle: {
  readonly bundleId: string;
  readonly bundleDigest: Digest;
  readonly proofRoot: Digest;
  readonly members: readonly ProofBundleMemberRef[];
  readonly bindings: BundleBindings;
  readonly signingKeyId: string;
  readonly rootSignature: Uint8Array;
}): Uint8Array {
  const orderedMembers: CanonicalBody = [...bundle.members]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((member) => ({
      bundleUnitId: member.bundleUnitId,
      kind: member.kind,
      ordinal: member.ordinal,
      unitDigest: member.unitDigest,
      verdict: member.verdict,
    }));
  return canonicalBytes([
    "tanren.proof-bundle-bytes.v1",
    {
      bindings: canonicalBindings(bundle.bindings),
      bundleDigest: bundle.bundleDigest,
      bundleId: bundle.bundleId,
      members: orderedMembers,
      proofRoot: bundle.proofRoot,
      rootSignature: Buffer.from(bundle.rootSignature).toString("hex"),
      signingKeyId: bundle.signingKeyId,
    },
  ]);
}

/** The CAS media type of a persisted, sealed proof bundle. */
export const PROOF_BUNDLE_MEDIA_TYPE = "application/vnd.tanren.proof-bundle+json";
/** The CAS media type of a persisted proof-unit body. */
export const PROOF_UNIT_MEDIA_TYPE = "application/vnd.tanren.proof-unit+json";

interface BundleIdContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly bundleDigest: Digest;
}

/**
 * Encode the org/project/bundle-digest context INTO the opaque bundle id. The
 * contract's `persistBundle(bundle)` receives only a `ProofBundleSealed` (no
 * org/project), yet must write org-scoped rows — so the tenant scope travels
 * inside the id as an injection-safe base64url(canonical JSON). Deterministic:
 * the same (org, project, digest) always yields the same id, so persistence is
 * idempotent by id AND digest.
 */
export function encodeBundleId(context: BundleIdContext): string {
  const json = canonicalJson({ d: context.bundleDigest, o: context.orgId, p: context.projectId });
  return `pb1_${Buffer.from(json, "utf8").toString("base64url")}`;
}

export class MalformedBundleIdError extends Error {
  public override readonly name = "MalformedBundleIdError";
  public constructor(raw: string) {
    super(`Malformed proof bundle id: ${raw}`);
  }
}

/** Decode the tenant scope embedded in a bundle id; throws on any malformed shape. */
export function decodeBundleId(bundleId: string): BundleIdContext {
  if (!bundleId.startsWith("pb1_")) {
    throw new MalformedBundleIdError(bundleId);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bundleId.slice("pb1_".length), "base64url").toString("utf8"));
  } catch {
    throw new MalformedBundleIdError(bundleId);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new MalformedBundleIdError(bundleId);
  }
  const record = parsed as Record<string, unknown>;
  const orgId = record["o"];
  const projectId = record["p"];
  const bundleDigest = record["d"];
  if (typeof orgId !== "string" || typeof projectId !== "string" || typeof bundleDigest !== "string") {
    throw new MalformedBundleIdError(bundleId);
  }
  const context: BundleIdContext = { orgId, projectId, bundleDigest: bundleDigest as Digest };
  // Defense in depth (audit Finding 4): reject any NON-CANONICAL encoding — extra
  // keys, unsorted keys, or non-canonical spacing that JSON.parse would accept for
  // the same (org, project, digest). Re-encode the decoded context and require it
  // reproduces the input byte-for-byte, so a bundle id has exactly one valid form.
  if (encodeBundleId(context) !== bundleId) {
    throw new MalformedBundleIdError(bundleId);
  }
  return context;
}

/** Deterministic per-row id for a `proof_bundle_units` row (stable ⇒ idempotent). */
export function bundleUnitId(bundleId: string, ordinal: number): string {
  return `${bundleId}.u${ordinal}`;
}
