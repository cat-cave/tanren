// mq-15 merge-train artifact contract. A completed land group projected into ONE
// strict, content-addressed, signed manifest. It is a PROJECTION of already-authoritative
// evidence (authority decision, integration proof root, land receipt, verified deploy,
// proof-backed demo); it invents no signer and no parallel CAS format. Signature sealing
// and verification are DELEGATED to the sole `ProofSubstrate` (engine/contracts/cas.ts) —
// this module only freezes the manifest shape + the deterministic canonical content hash,
// and the offline (DB-free) validation that a manifest's member order + terminal evidence
// are internally exact. A partial/mismatched train can never parse as a sealed delivery.

import { z } from "zod";
import { canonicalJson, contentDigestOf, type CanonicalBody } from "./cas.js";

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const HexSignature = z
  .string()
  .regex(/^[0-9a-f]+$/u)
  .min(2)
  .refine((value) => value.length % 2 === 0, "signature hex must be byte-aligned");

/** Frozen schema version — never re-minted; a new shape is a new version. */
export const MERGE_TRAIN_ARTIFACT_SCHEMA_VERSION = "merge_train_artifact.v1";
export const MERGE_TRAIN_ARTIFACT_MEDIA_TYPE = "application/vnd.tanren.merge-train-artifact+json";

/** One ordered land-group member, bound by its frozen `memberKey` and run identity. */
export const MergeTrainMember = z
  .object({
    ordinal: z.number().int().nonnegative(),
    memberKey: z.string().min(1),
    runId: z.string().min(1),
    specId: z.string().min(1),
    prNumber: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type MergeTrainMember = z.infer<typeof MergeTrainMember>;

/** The verified-deploy identity projected from `deploy.verified` (no secrets). */
export const MergeTrainDeployIdentity = z
  .object({
    provider: z.string().min(1),
    appId: z.string().min(1),
    deploymentId: z.string().min(1),
    url: z.string().min(1),
    state: z.string().min(1),
  })
  .strict();
export type MergeTrainDeployIdentity = z.infer<typeof MergeTrainDeployIdentity>;

/** The proof-backed demo terminal result projected from `demo.completed`. */
export const MergeTrainDemoResult = z
  .object({
    surfaceKind: z.string().min(1),
    behaviorCount: z.number().int().positive(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
export type MergeTrainDemoResult = z.infer<typeof MergeTrainDemoResult>;

/** The `ProofBundleSealed` projection carried in the manifest: digests/key/signature only. */
export const MergeTrainSealedBundle = z
  .object({
    bundleId: z.string().min(1),
    bundleDigest: Sha256,
    proofRoot: Sha256,
    bytesDigest: Sha256,
    signingKeyId: z.string().min(1),
    rootSignatureHex: HexSignature,
  })
  .strict();
export type MergeTrainSealedBundle = z.infer<typeof MergeTrainSealedBundle>;

export const MergeTrainReceipt = z
  .object({
    mainSha: z.string().min(1),
    auditId: z.string().min(1),
  })
  .strict();

/**
 * The frozen `MergeTrainArtifactV1`. `.strict()` at every level: an unknown key,
 * a missing terminal-evidence branch, or an out-of-order member all fail the parse.
 */
export const MergeTrainArtifactV1 = z
  .object({
    version: z.literal(1),
    schemaVersion: z.literal(MERGE_TRAIN_ARTIFACT_SCHEMA_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    landGroupId: z.string().min(1),
    authorityDecisionId: z.string().min(1),
    integrationNodeId: z.string().min(1),
    proofRoot: Sha256,
    receipt: MergeTrainReceipt,
    members: z.array(MergeTrainMember).min(1),
    deploy: MergeTrainDeployIdentity,
    demo: MergeTrainDemoResult,
    sealedBundle: MergeTrainSealedBundle,
    contentHash: Sha256,
  })
  .strict();
export type MergeTrainArtifactV1 = z.infer<typeof MergeTrainArtifactV1>;

/** The manifest body WITHOUT the derived `contentHash` — the canonical hash pre-image. */
export type MergeTrainArtifactBody = Omit<MergeTrainArtifactV1, "contentHash">;

/** The pre-seal projection: everything the watcher gathers BEFORE the substrate seals. */
export type MergeTrainArtifactDraft = Omit<MergeTrainArtifactV1, "contentHash" | "sealedBundle">;

export class MergeTrainArtifactInvalidError extends Error {
  public override readonly name = "MergeTrainArtifactInvalidError";
  public constructor(reason: string) {
    super(`Merge-train artifact is invalid: ${reason}`);
  }
}

/**
 * Canonicalize the manifest body (minus `contentHash`) into a deterministic
 * `CanonicalBody`. Member order is preserved (arrays keep their order under
 * `canonicalJson`), so a reordered/added/dropped member changes the hash.
 */
export function mergeTrainArtifactCanonicalBody(body: MergeTrainArtifactBody): CanonicalBody {
  return {
    version: body.version,
    schemaVersion: body.schemaVersion,
    orgId: body.orgId,
    projectId: body.projectId,
    landGroupId: body.landGroupId,
    authorityDecisionId: body.authorityDecisionId,
    integrationNodeId: body.integrationNodeId,
    proofRoot: body.proofRoot,
    receipt: { mainSha: body.receipt.mainSha, auditId: body.receipt.auditId },
    members: body.members.map((member) => ({
      ordinal: member.ordinal,
      memberKey: member.memberKey,
      runId: member.runId,
      specId: member.specId,
      prNumber: member.prNumber,
    })),
    deploy: {
      provider: body.deploy.provider,
      appId: body.deploy.appId,
      deploymentId: body.deploy.deploymentId,
      url: body.deploy.url,
      state: body.deploy.state,
    },
    demo: {
      surfaceKind: body.demo.surfaceKind,
      behaviorCount: body.demo.behaviorCount,
      passed: body.demo.passed,
      failed: body.demo.failed,
    },
    sealedBundle: {
      bundleId: body.sealedBundle.bundleId,
      bundleDigest: body.sealedBundle.bundleDigest,
      proofRoot: body.sealedBundle.proofRoot,
      bytesDigest: body.sealedBundle.bytesDigest,
      signingKeyId: body.sealedBundle.signingKeyId,
      rootSignatureHex: body.sealedBundle.rootSignatureHex,
    },
  };
}

/**
 * The single canonical bytes encoding served over the artifact route + stored in CAS.
 * It is the FULL manifest (the body PLUS its derived `contentHash`), so the CAS bytes
 * decode to exactly the served manifest.
 */
export function encodeMergeTrainArtifactBytes(artifact: MergeTrainArtifactV1): Uint8Array {
  const body = mergeTrainArtifactCanonicalBody(artifact) as { [k: string]: CanonicalBody };
  return new TextEncoder().encode(canonicalJson({ ...body, contentHash: artifact.contentHash }));
}

/** The deterministic content hash over the body (minus `contentHash` itself). */
export function computeMergeTrainContentHash(body: MergeTrainArtifactBody): string {
  return contentDigestOf(new TextEncoder().encode(canonicalJson(mergeTrainArtifactCanonicalBody(body))));
}

/** Finalize a body into a frozen artifact by stamping its canonical content hash. */
export function finalizeMergeTrainArtifact(body: MergeTrainArtifactBody): MergeTrainArtifactV1 {
  return MergeTrainArtifactV1.parse({ ...body, contentHash: computeMergeTrainContentHash(body) });
}

/**
 * Offline, DB-free validation. Parses `.strict()`, re-derives the content hash and
 * requires it to match (so any mutated field or reordered member is rejected), and
 * asserts the member ordinals are exactly 0..n-1 in order. It does NOT trust a
 * UI-provided key: signature verification is the `ProofSubstrate`'s job at seal time.
 */
export function validateMergeTrainArtifact(raw: unknown): MergeTrainArtifactV1 {
  const parsed = MergeTrainArtifactV1.safeParse(raw);
  if (!parsed.success) {
    throw new MergeTrainArtifactInvalidError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const artifact = parsed.data;
  artifact.members.forEach((member, index) => {
    if (member.ordinal !== index) {
      throw new MergeTrainArtifactInvalidError(`member ordinal ${member.ordinal} is out of order at position ${index}`);
    }
  });
  const { contentHash: _contentHash, ...body } = artifact;
  const recomputed = computeMergeTrainContentHash(body);
  if (recomputed !== artifact.contentHash) {
    throw new MergeTrainArtifactInvalidError(
      `content hash mismatch (declared ${artifact.contentHash}, recomputed ${recomputed})`,
    );
  }
  return artifact;
}
