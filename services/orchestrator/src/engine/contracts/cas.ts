/**
 * SP-3 is Tanren's SOLE proof/CAS substrate. The branded Digest is the ONLY
 * content and artifact identity. The frozen six-component proofReuseKey and
 * memberKey in integrationNodes.ts are permanent exceptions and are never
 * routed through this module. Every consumer imports this contract from the
 * exact specifier services/orchestrator/src/engine/contracts/cas.js.
 */

import { createHash } from "node:crypto";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PROVIDER_CHECKSUM_PATTERN = /^sha512:[0-9a-f]{128}$/u;

export type Digest = string & { readonly __brand: "Digest" };

export type ProviderChecksum = string & { readonly __brand: "ProviderChecksum" };

export class MalformedDigestError extends Error {
  public override readonly name = "MalformedDigestError";

  public constructor(raw: string) {
    super(`Malformed digest: ${raw}`);
  }
}

export class MalformedProviderChecksumError extends Error {
  public override readonly name = "MalformedProviderChecksumError";

  public constructor(raw: string) {
    super(`Malformed provider checksum: ${raw}`);
  }
}

export class UnknownDomainTagError extends Error {
  public override readonly name = "UnknownDomainTagError";

  public constructor(tag: string) {
    super(`Unknown domain tag: ${tag}`);
  }
}

export class CasArtifactNotFoundError extends Error {
  public override readonly name = "CasArtifactNotFoundError";

  public constructor(orgId: string, digest: Digest) {
    super(`CAS artifact not found for org ${orgId}: ${digest}`);
  }
}

export function parseDigest(raw: string): Digest {
  if (!DIGEST_PATTERN.test(raw)) {
    throw new MalformedDigestError(raw);
  }
  return raw as Digest;
}

export function parseProviderChecksum(raw: string): ProviderChecksum {
  if (!PROVIDER_CHECKSUM_PATTERN.test(raw)) {
    throw new MalformedProviderChecksumError(raw);
  }
  return raw as ProviderChecksum;
}

export const DOMAIN_TAGS = [
  "persona_revision.v1",
  "behavior_revision.v1",
  "runtime_behavior_context.v1",
  "plan.v1",
  // in-2 consumer extension: typed IntegrationRequirementV1 content identity.
  // Compatible additive DomainTag; not a second Digest/hash family.
  "integration_requirement.v1",
] as const;

export type DomainTag = (typeof DOMAIN_TAGS)[number];

export type CanonicalBody =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalBody[]
  | { readonly [k: string]: CanonicalBody };

function canonicalJson(value: CanonicalBody): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain a non-finite number");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const objectValue = value as { readonly [k: string]: CanonicalBody };
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key]!)}`)
    .join(",")}}`;
}

export function domainHash(tag: DomainTag, body: CanonicalBody): Digest {
  if (!(DOMAIN_TAGS as readonly string[]).includes(tag)) {
    throw new UnknownDomainTagError(tag);
  }

  const canonicalInput: readonly [DomainTag, CanonicalBody] = [tag, body];
  const hex = createHash("sha256").update(canonicalJson(canonicalInput)).digest("hex");
  return `sha256:${hex}` as Digest;
}

export type ProofUnitKind =
  | "native_ci_tier"
  | "native_ci_step"
  | "test"
  | "runtime_behavior"
  | "design_render"
  | "artifact_provenance"
  | "audit_rule"
  | "security_finding";

export type ProofUnitVerdict = "passed" | "failed" | "unknown";

export interface ProofUnitDraft {
  readonly kind: ProofUnitKind;
  readonly verdict: ProofUnitVerdict;
  readonly subjectId: string;
  readonly body: CanonicalBody;
  readonly evidenceDigests?: readonly Digest[];
}

export interface ProofUnitRef {
  readonly digest: Digest;
  readonly kind: ProofUnitKind;
  readonly verdict: ProofUnitVerdict;
}

export interface ProofUnit extends ProofUnitRef {
  readonly orgId: string;
  readonly projectId: string;
  readonly subjectId: string;
  readonly evidenceDigests: readonly Digest[];
  readonly createdAt: string;
}

export interface CasArtifactRef {
  readonly digest: Digest;
  readonly byteSize: number;
  readonly mediaType: string;
}

export interface CasArtifactBytes {
  readonly digest: Digest;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface CasByteStore {
  put(input: {
    readonly orgId: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<CasArtifactRef>;
  get(orgId: string, digest: Digest): Promise<CasArtifactBytes>;
  has(orgId: string, digest: Digest): Promise<boolean>;
}

export interface BundleBindings {
  readonly integrationNodeId: string;
  readonly memberSetHash: string;
  readonly preparedHeadSha: string;
  readonly jjTreeId: string;
  readonly artifactDigest: Digest;
  readonly expectedMainSha: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface ProofBundleSealed {
  readonly bundleId: string;
  readonly bundleDigest: Digest;
  readonly proofRoot: Digest;
  readonly members: readonly ProofBundleMemberRef[];
  readonly bindings: BundleBindings;
  readonly bytesDigest: Digest;
  readonly signingKeyId: string;
  readonly rootSignature: Uint8Array;
}

export interface ProofBundleRef {
  readonly bundleId: string;
  readonly bundleDigest: Digest;
  readonly proofRoot: Digest;
  readonly bytesDigest: Digest;
  readonly members: readonly ProofBundleMemberRef[];
}

export interface ProofBundleMemberRef {
  readonly bundleUnitId: string;
  readonly unitDigest: Digest;
  readonly kind: ProofUnitKind;
  readonly verdict: ProofUnitVerdict;
  readonly ordinal: number;
}

export interface ProofVerification {
  readonly valid: boolean;
  readonly reason?: string;
}

/** Validates a canonical gate-section body and throws when the body is invalid. */
export type SectionBodyValidator = (kind: ProofUnitKind, body: CanonicalBody) => void;

export interface ProofSubstrate {
  ingestUnits(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly drafts: readonly ProofUnitDraft[];
    /**
     * SP-7 passes a validator that runs the matching gateProof.ts
     * <Section>BodySchema.parse for runtime_behavior, design_render,
     * artifact_provenance, native_ci_tier, and native_ci_step. Ingestion
     * invokes it for every draft before content-addressing the body.
     */
    readonly validateSectionBody?: SectionBodyValidator;
  }): Promise<readonly ProofUnitRef[]>;
  computeRoot(members: readonly ProofUnitRef[]): Digest;
  seal(input: {
    readonly proofRoot: Digest;
    readonly bindings: BundleBindings;
  }): Promise<{ readonly signingKeyId: string; readonly rootSignature: Uint8Array }>;
  constructBundle(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly members: readonly ProofUnitRef[];
    readonly bindings: BundleBindings;
  }): Promise<ProofBundleSealed>;
  verify(bundle: ProofBundleSealed): Promise<ProofVerification>;
  persistBundle(bundle: ProofBundleSealed): Promise<ProofBundleRef>;
}
