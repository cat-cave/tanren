/**
 * SP-3 — `PgProofSubstrate`: the ONE canonical production `ProofSubstrate`. It is
 * the SOLE proof-sealing/verification substrate for the spine — there is no
 * parallel CAS and no second signer. It builds ON `PgCasByteStore` (the sole CAS
 * byte store over migration 0035's `cas_artifacts`) and persists into 0035's
 * `proof_units` / `proof_bundles` / `proof_bundle_units` tables, all org-scoped
 * under RLS.
 *
 * SECURITY POSTURE (fail-closed, never fabricate):
 * - `seal` signs with a platform ed25519 key resolved from the `SecretStore`;
 *   a missing key THROWS (never signs with nothing, never fabricates a signature).
 * - `verify` defaults to INVALID on ANY mismatch or uncertainty: a tampered or
 *   reordered member, a wrong root, an inconsistent bundle/bytes digest, a bad
 *   signature, or an unknown/mismatched signing key all return `{ valid: false }`.
 *   `{ valid: true }` is returned ONLY when every independent re-check passes.
 * - `persistBundle` RE-VERIFIES before writing — an unverifiable bundle is never
 *   durably persisted.
 *
 * The deterministic Merkle/serialization math lives in `proofSubstrateCodec.ts`
 * and the key resolution in `proofSigningKey.ts`, so `verify`'s fail-closed arms
 * are DB-free unit-testable.
 */

import { sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type {
  BundleBindings,
  CasByteStore,
  Digest,
  ProofBundleMemberRef,
  ProofBundleRef,
  ProofBundleSealed,
  ProofSubstrate,
  ProofUnitDraft,
  ProofUnitRef,
  ProofVerification,
  SectionBodyValidator,
} from "../contracts/cas.js";
import { contentDigestOf } from "../contracts/cas.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { PgCasByteStore } from "./pgCasByteStore.js";
import { PROOF_SIGNING_KEY_REF, resolveSigningKey } from "./proofSigningKey.js";
// Re-exported so the worker boot (autonomyLoops) wires the substrate + its
// boot-time key probe from a SINGLE module import.
export { PROOF_SIGNING_KEY_REF, resolveSigningKey } from "./proofSigningKey.js";
import {
  bundleUnitId,
  canonicalSealMessage,
  computeBundleDigest,
  computeProofRoot,
  decodeBundleId,
  encodeBundleId,
  PROOF_BUNDLE_MEDIA_TYPE,
  PROOF_UNIT_MEDIA_TYPE,
  proofUnitContentBytes,
  serializeBundleBytes,
} from "./proofSubstrateCodec.js";

/** A proof bundle must seal over at least one member unit. */
export class EmptyProofBundleError extends Error {
  public override readonly name = "EmptyProofBundleError";
  public constructor() {
    super("A proof bundle must contain at least one member unit; refusing to seal an empty bundle.");
  }
}

/** Two members addressing the same unit digest — the member set is not a set. */
export class DuplicateProofMemberError extends Error {
  public override readonly name = "DuplicateProofMemberError";
  public constructor(digest: Digest) {
    super(`Duplicate proof member unit digest in bundle: ${digest}`);
  }
}

/** persistBundle refused because the bundle did not verify (fail-closed). */
export class ProofBundleNotVerifiedError extends Error {
  public override readonly name = "ProofBundleNotVerifiedError";
  public constructor(reason: string) {
    super(`Refusing to persist a proof bundle that does not verify: ${reason}`);
  }
}

export interface PgProofSubstrateOptions {
  /** Injected for tests; production composes `PgCasByteStore(pool)`. */
  readonly casByteStore?: CasByteStore;
  /** Overrides the platform signing-key ref (tests inject a hermetic key ref). */
  readonly signingKeyRef?: string;
}

export class PgProofSubstrate implements ProofSubstrate {
  private readonly casByteStore: CasByteStore;
  private readonly signingKeyRef: string;

  public constructor(
    private readonly pool: pg.Pool,
    private readonly secrets: SecretStore,
    options: PgProofSubstrateOptions = {},
  ) {
    this.casByteStore = options.casByteStore ?? new PgCasByteStore(pool);
    this.signingKeyRef = options.signingKeyRef ?? PROOF_SIGNING_KEY_REF;
  }

  public async ingestUnits(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly drafts: readonly ProofUnitDraft[];
    readonly validateSectionBody?: SectionBodyValidator;
  }): Promise<readonly ProofUnitRef[]> {
    const refs: ProofUnitRef[] = [];
    for (const draft of input.drafts) {
      // SP-7: validate the gate-section body BEFORE content-addressing. A draft
      // failing validation THROWS here — it is never silently ingested.
      input.validateSectionBody?.(draft.kind, draft.body);
      // Content identity binds kind + verdict + body (audit Finding 3): a
      // same-body/different-verdict (or -kind) unit gets a DISTINCT digest, so the
      // `ON CONFLICT DO NOTHING` below can never first-writer-win a colliding row.
      const bytes = proofUnitContentBytes(draft);
      const casRef = await this.casByteStore.put({ orgId: input.orgId, bytes, mediaType: PROOF_UNIT_MEDIA_TYPE });
      const digest = casRef.digest;
      const evidenceDigests = draft.evidenceDigests ?? [];
      await runWithOrgScope(this.pool, input.orgId, async (client) => {
        await client.query(
          `INSERT INTO proof_units (org_id, project_id, proof_unit_digest, kind, verdict, subject_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (org_id, proof_unit_digest) DO NOTHING`,
          [input.orgId, input.projectId, digest, draft.kind, draft.verdict, draft.subjectId],
        );
        for (let ordinal = 0; ordinal < evidenceDigests.length; ordinal += 1) {
          await client.query(
            `INSERT INTO proof_unit_evidence (org_id, project_id, proof_unit_digest, evidence_digest, ordinal)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (org_id, proof_unit_digest, evidence_digest) DO NOTHING`,
            [input.orgId, input.projectId, digest, evidenceDigests[ordinal], ordinal],
          );
        }
      });
      refs.push({ digest, kind: draft.kind, verdict: draft.verdict });
    }
    return refs;
  }

  public computeRoot(members: readonly ProofUnitRef[]): Digest {
    return computeProofRoot(members);
  }

  public async seal(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly bundleDigest: Digest;
    readonly proofRoot: Digest;
    readonly bindings: BundleBindings;
  }): Promise<{ readonly signingKeyId: string; readonly rootSignature: Uint8Array }> {
    // Fail-loud on a missing/malformed key — NEVER sign with an empty/zero key.
    const key = await resolveSigningKey(this.secrets, this.signingKeyRef);
    // Sign over the FULL identity — tenant + bundle id are inside the envelope, so
    // a proof cannot be rebound to another org/project/bundle without re-signing.
    const message = canonicalSealMessage({
      orgId: input.orgId,
      projectId: input.projectId,
      bundleDigest: input.bundleDigest,
      proofRoot: input.proofRoot,
      bindings: input.bindings,
    });
    const rootSignature = new Uint8Array(ed25519Sign(null, message, key.privateKey));
    return { signingKeyId: key.signingKeyId, rootSignature };
  }

  public async constructBundle(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly members: readonly ProofUnitRef[];
    readonly bindings: BundleBindings;
  }): Promise<ProofBundleSealed> {
    if (input.members.length === 0) {
      throw new EmptyProofBundleError();
    }
    const seen = new Set<Digest>();
    for (const member of input.members) {
      if (seen.has(member.digest)) {
        throw new DuplicateProofMemberError(member.digest);
      }
      seen.add(member.digest);
    }
    const proofRoot = computeProofRoot(input.members);
    const baseMembers = input.members.map((member, ordinal) => ({
      unitDigest: member.digest,
      kind: member.kind,
      verdict: member.verdict,
      ordinal,
    }));
    const bundleDigest = computeBundleDigest({ proofRoot, members: baseMembers, bindings: input.bindings });
    const bundleId = encodeBundleId({ orgId: input.orgId, projectId: input.projectId, bundleDigest });
    const members: ProofBundleMemberRef[] = baseMembers.map((member) => ({
      ...member,
      bundleUnitId: bundleUnitId(bundleId, member.ordinal),
    }));
    const { signingKeyId, rootSignature } = await this.seal({
      orgId: input.orgId,
      projectId: input.projectId,
      bundleDigest,
      proofRoot,
      bindings: input.bindings,
    });
    const bytes = serializeBundleBytes({
      bundleId,
      bundleDigest,
      proofRoot,
      members,
      bindings: input.bindings,
      signingKeyId,
      rootSignature,
    });
    const bytesDigest = contentDigestOf(bytes);
    return {
      bundleId,
      bundleDigest,
      proofRoot,
      members,
      bindings: input.bindings,
      bytesDigest,
      signingKeyId,
      rootSignature,
    };
  }

  public async verify(bundle: ProofBundleSealed): Promise<ProofVerification> {
    const members = [...bundle.members].sort((a, b) => a.ordinal - b.ordinal);
    if (members.length === 0) {
      return { valid: false, reason: "bundle has no members" };
    }
    // Structural integrity: contiguous 0..n-1 ordinals, unique digests + unit ids,
    // and each unit id must bind (bundleId ‖ ordinal). Any deviation is a tamper.
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index]!;
      if (member.ordinal !== index) {
        return { valid: false, reason: "member ordinals are not a contiguous 0..n-1 sequence" };
      }
      if (member.bundleUnitId !== bundleUnitId(bundle.bundleId, member.ordinal)) {
        return { valid: false, reason: "bundle unit id does not bind the bundle id and ordinal" };
      }
    }
    if (new Set(members.map((member) => member.unitDigest)).size !== members.length) {
      return { valid: false, reason: "duplicate member unit digest" };
    }
    // Recompute the Merkle root from the members and require it equals the sealed
    // root — catches a tampered or reordered member set.
    const recomputedRoot = computeProofRoot(
      members.map((member) => ({ digest: member.unitDigest, kind: member.kind, verdict: member.verdict })),
    );
    if (recomputedRoot !== bundle.proofRoot) {
      return { valid: false, reason: "recomputed proof root does not match the sealed proof root" };
    }
    const recomputedBundleDigest = computeBundleDigest({
      proofRoot: bundle.proofRoot,
      members,
      bindings: bundle.bindings,
    });
    if (recomputedBundleDigest !== bundle.bundleDigest) {
      return { valid: false, reason: "recomputed bundle digest does not match" };
    }
    let context;
    try {
      context = decodeBundleId(bundle.bundleId);
    } catch {
      return { valid: false, reason: "malformed bundle id" };
    }
    if (context.bundleDigest !== bundle.bundleDigest) {
      return { valid: false, reason: "bundle id does not bind the bundle digest" };
    }
    if (contentDigestOf(serializeBundleBytes(bundle)) !== bundle.bytesDigest) {
      return { valid: false, reason: "recomputed bytes digest does not match" };
    }
    // Root trust in the SecretStore key, never a key carried by the bundle. Absent
    // key → INVALID (fail-closed), never a false success.
    let key;
    try {
      key = await resolveSigningKey(this.secrets, this.signingKeyRef);
    } catch (error) {
      return { valid: false, reason: `signing key unavailable for verification: ${errorMessage(error)}` };
    }
    if (key.signingKeyId !== bundle.signingKeyId) {
      return { valid: false, reason: "unknown or mismatched signingKeyId" };
    }
    // Recompute the signed message from the bundle's OWN tenant + bundle identity
    // (decoded from bundleId, whose digest was checked == bundleDigest above). A
    // bundle rewritten to another org/project (audit Finding 1) yields a DIFFERENT
    // message here, so the unchanged signature no longer verifies → invalid.
    const message = canonicalSealMessage({
      orgId: context.orgId,
      projectId: context.projectId,
      bundleDigest: bundle.bundleDigest,
      proofRoot: bundle.proofRoot,
      bindings: bundle.bindings,
    });
    let signatureValid = false;
    try {
      signatureValid = ed25519Verify(null, message, key.publicKey, bundle.rootSignature);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      return { valid: false, reason: "ed25519 signature verification failed" };
    }
    return { valid: true };
  }

  public async persistBundle(bundle: ProofBundleSealed): Promise<ProofBundleRef> {
    // Fail-closed: NEVER durably persist a bundle that does not verify.
    const verification = await this.verify(bundle);
    if (!verification.valid) {
      throw new ProofBundleNotVerifiedError(verification.reason ?? "unknown reason");
    }
    const context = decodeBundleId(bundle.bundleId);
    const members = [...bundle.members].sort((a, b) => a.ordinal - b.ordinal);
    // Persist the canonical bundle bytes into the CAS so `bytes_digest` FKs resolve.
    await this.casByteStore.put({
      orgId: context.orgId,
      bytes: serializeBundleBytes(bundle),
      mediaType: PROOF_BUNDLE_MEDIA_TYPE,
    });
    const b = bundle.bindings;
    await runWithOrgScope(this.pool, context.orgId, async (client) => {
      await client.query(
        `INSERT INTO proof_bundles (
           org_id, id, project_id, bundle_digest, proof_root, bytes_digest,
           integration_node_id, member_set_hash, prepared_head_sha, jj_tree_id,
           artifact_digest, expected_main_sha, signing_key_id, root_signature,
           nonce, issued_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10,
           $11, $12, $13, $14,
           $15, $16, $17
         )
         ON CONFLICT (org_id, bundle_digest) DO NOTHING`,
        [
          context.orgId,
          bundle.bundleId,
          context.projectId,
          bundle.bundleDigest,
          bundle.proofRoot,
          bundle.bytesDigest,
          b.integrationNodeId,
          b.memberSetHash,
          b.preparedHeadSha,
          b.jjTreeId,
          b.artifactDigest,
          b.expectedMainSha,
          bundle.signingKeyId,
          Buffer.from(bundle.rootSignature),
          b.nonce,
          b.issuedAt,
          b.expiresAt,
        ],
      );
      for (const member of members) {
        await client.query(
          `INSERT INTO proof_bundle_units (org_id, id, project_id, bundle_id, proof_unit_digest, ordinal)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (org_id, id) DO NOTHING`,
          [context.orgId, member.bundleUnitId, context.projectId, bundle.bundleId, member.unitDigest, member.ordinal],
        );
      }
    });
    return {
      bundleId: bundle.bundleId,
      bundleDigest: bundle.bundleDigest,
      proofRoot: bundle.proofRoot,
      bytesDigest: bundle.bytesDigest,
      members: bundle.members,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
