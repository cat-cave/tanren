// cspell:ignore vcap
/**
 * rv-9 SP-3 consumer: the runtime-verification RENDER/RESPONSE capture store.
 *
 * A verification run's render-capture stage hands raw evidence bytes here; this
 * store content-addresses them into the SP-3 CAS byte store (`cas_artifacts`,
 * the digest IS the address) and records an org-scoped `verification_artifacts`
 * provenance row pointing at that digest. It is DISTINCT from the design CAS
 * (`engine/design/system/artifactStore.ts`) and from the bh-5 symptom-evidence
 * writer — this is the acceptance-run artifact store.
 *
 * FAIL-CLOSED at every edge (never a false success):
 *  - the caller-claimed content digest, when supplied, MUST equal the SHA-256 of
 *    the actual bytes, else {@link CaptureDigestMismatchError};
 *  - the CAS put's returned digest MUST equal the locally-computed content
 *    digest, else {@link CaptureDigestMismatchError};
 *  - a readback re-hashes through the CAS integrity check, so a corrupt/tampered
 *    row is a typed error, never silently returned.
 *
 * CONTENT-ADDRESSED DEDUPE: the `verification_artifacts` row id is derived
 * deterministically from (projectId, casDigest, kind), so capturing identical
 * content of the same kind collapses onto the same provenance row (the PK), and
 * the CAS layer already dedupes the bytes onto one `cas_artifacts` row.
 */

import { runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import type pg from "pg";
import type { CasByteStore, Digest } from "../../contracts/cas.js";
import { contentDigestOf, parseDigest } from "../../contracts/cas.js";
import type { RedactionClass, VerificationArtifactId } from "../../contracts/runtimeVerificationPlan.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;

/** A raised-loud integrity failure: claimed vs actual content digest disagree. */
export class CaptureDigestMismatchError extends Error {
  public override readonly name = "CaptureDigestMismatchError";

  public constructor(
    public readonly orgId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`capture content digest mismatch for org ${orgId}: expected ${expected}, computed ${actual}`);
  }
}

/** Raised when a capture references a project outside the requesting org. */
export class CaptureProjectScopeError extends Error {
  public override readonly name = "CaptureProjectScopeError";

  public constructor(orgId: string, projectId: string) {
    super(`project ${projectId} does not belong to org ${orgId}`);
  }
}

/** Raised when a readback targets a verification-artifact row that does not exist in scope. */
export class VerificationArtifactNotFoundError extends Error {
  public override readonly name = "VerificationArtifactNotFoundError";

  public constructor(orgId: string, id: string) {
    super(`verification artifact ${id} not found for org ${orgId}`);
  }
}

export interface CaptureArtifactInput {
  readonly orgId: string;
  readonly projectId: string;
  /** Free-text artifact kind (e.g. "response_capture", "render_dom"). */
  readonly kind: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly redactionClass: RedactionClass;
  readonly retentionClass?: string;
  /**
   * Optional caller-asserted content digest. When present it MUST equal the
   * SHA-256 of {@link bytes}; a mismatch fails closed (a claimed address can
   * never diverge from the content it names).
   */
  readonly expectedDigest?: Digest;
  /**
   * rv-10: the real attempt (behavior_verification_attempts) this capture was produced by.
   * When present it is persisted as `verification_artifacts.producing_attempt_id` (FK-bound),
   * so a captured artifact traces to a real attempt instead of a NULL. Absent ⇒ NULL (the
   * standalone capture path with no run/attempt context). A non-existent id fails closed on
   * the FK. Content-addressed dedupe keeps the FIRST producing attempt on the row.
   */
  readonly producingAttemptId?: string;
}

export interface CapturedArtifactRef {
  readonly verificationArtifactId: VerificationArtifactId;
  readonly casDigest: Digest;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly kind: string;
  /** True when identical content of this kind was already stored (address reused). */
  readonly deduped: boolean;
}

export interface ReadCapturedArtifact {
  readonly verificationArtifactId: VerificationArtifactId;
  readonly casDigest: Digest;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly kind: string;
  readonly redactionClass: RedactionClass;
  readonly retentionClass: string;
  /** The verified bytes — re-hashed through the CAS integrity check on read. */
  readonly bytes: Uint8Array;
}

/** The rv-9 capture persistence seam; swappable for a conformance fake. */
export interface VerificationCaptureStore {
  capture(input: CaptureArtifactInput): Promise<CapturedArtifactRef>;
  read(input: {
    readonly orgId: string;
    readonly verificationArtifactId: VerificationArtifactId;
  }): Promise<ReadCapturedArtifact>;
}

interface StoredRow {
  readonly id: string;
  readonly cas_digest: string;
  readonly media_type: string;
  readonly byte_size: string | number;
  readonly kind: string;
  readonly redaction_class: RedactionClass;
  readonly retention_class: string;
}

/** Derive the content-addressed provenance-row id (dedupe via the PK). */
export function captureArtifactId(projectId: string, casDigest: Digest, kind: string): VerificationArtifactId {
  const hex = createHash("sha256").update(`${projectId}\n${casDigest}\n${kind}`).digest("hex");
  return `vcap_${hex}` as VerificationArtifactId;
}

function toByteSize(raw: string | number): number {
  const size = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`verification artifact byte_size is not a safe nonnegative integer: ${String(raw)}`);
  }
  return size;
}

export interface PgVerificationCaptureStoreDependencies {
  /** Test seam; production always runs on runWithOrgScope over the control pool. */
  readonly withOrgScope?: OrgScope;
}

/** Postgres capture store over the SP-3 CAS byte store + RLS-forced `verification_artifacts`. */
export class PgVerificationCaptureStore implements VerificationCaptureStore {
  private readonly withOrgScope: OrgScope;

  public constructor(
    pool: pg.Pool,
    private readonly cas: CasByteStore,
    dependencies: PgVerificationCaptureStoreDependencies = {},
  ) {
    this.withOrgScope = dependencies.withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
  }

  public async capture(input: CaptureArtifactInput): Promise<CapturedArtifactRef> {
    // 1. Content-address the raw bytes locally and reject a diverging claim.
    const computed = contentDigestOf(input.bytes);
    if (input.expectedDigest !== undefined && input.expectedDigest !== computed) {
      throw new CaptureDigestMismatchError(input.orgId, input.expectedDigest, computed);
    }
    // 2. Store the bytes in the SP-3 CAS (the digest is the address); reject a
    //    store that ever returns a digest disagreeing with the actual content.
    const ref = await this.cas.put({ orgId: input.orgId, bytes: input.bytes, mediaType: input.mediaType });
    if (ref.digest !== computed) {
      throw new CaptureDigestMismatchError(input.orgId, computed, ref.digest);
    }
    const id = captureArtifactId(input.projectId, ref.digest, input.kind);
    // 3. Record the org-scoped provenance row; the deterministic id dedupes
    //    identical content of the same kind onto one address via the PK.
    return this.withOrgScope(input.orgId, async (client) => {
      await this.assertProject(client, input.orgId, input.projectId);
      // `proof_unit_digest` stays NULL on the acceptance-run path (no proof unit is compiled
      // here). rv-10: `producing_attempt_id`, once NULL by design, is the real attempt the run
      // recorded (behavior_verification_attempts) when the caller threads it — so a captured
      // artifact traces to a real attempt. It is FK-bound: a non-existent id fails closed. Absent
      // ⇒ NULL (the standalone capture path outside a run). rv-10 FINDING 3: on a content-addressed
      // dedupe conflict, BACKFILL `producing_attempt_id` when the existing row is still NULL and
      // this write supplies one (COALESCE keeps an already-set attempt — never overwrites it). So a
      // prior standalone/NULL capture of the same (project, digest, kind) can no longer strand a
      // later production write (which passes attemptId) with a NULL producing attempt. The DURABLE
      // verdict→capture linkage still lives in `behavior_verdict_evidence` (verdict-scoped); this
      // attempt link is orthogonal provenance. `xmax = 0` distinguishes a fresh insert from a
      // conflict-update so `deduped` stays accurate.
      const inserted = await client.query<{ inserted: boolean }>(
        `INSERT INTO verification_artifacts
           (org_id, id, project_id, cas_digest, proof_unit_digest, kind, media_type,
            byte_size, redaction_class, retention_class, producing_attempt_id)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (org_id, id) DO UPDATE
           SET producing_attempt_id =
                 COALESCE(verification_artifacts.producing_attempt_id, EXCLUDED.producing_attempt_id)
         RETURNING (xmax = 0) AS inserted`,
        [
          input.orgId,
          id,
          input.projectId,
          ref.digest,
          input.kind,
          input.mediaType,
          ref.byteSize,
          input.redactionClass,
          input.retentionClass ?? "standard",
          input.producingAttemptId ?? null,
        ],
      );
      const deduped = inserted.rows[0]?.inserted !== true;
      const row = await this.selectRow(client, input.orgId, id);
      if (row === undefined) throw new VerificationArtifactNotFoundError(input.orgId, id);
      // Defense in depth: a pre-existing row addressed by this id MUST carry the
      // same content digest — a hash collision on the id can never launder one
      // artifact's bytes under another's address.
      if (row.cas_digest !== ref.digest) {
        throw new CaptureDigestMismatchError(input.orgId, ref.digest, row.cas_digest);
      }
      return {
        verificationArtifactId: id,
        casDigest: parseDigest(row.cas_digest),
        mediaType: row.media_type,
        byteSize: toByteSize(row.byte_size),
        kind: row.kind,
        deduped,
      };
    });
  }

  public async read(input: {
    readonly orgId: string;
    readonly verificationArtifactId: VerificationArtifactId;
  }): Promise<ReadCapturedArtifact> {
    const row = await this.withOrgScope(input.orgId, (client) =>
      this.selectRow(client, input.orgId, input.verificationArtifactId),
    );
    if (row === undefined) {
      throw new VerificationArtifactNotFoundError(input.orgId, input.verificationArtifactId);
    }
    const casDigest = parseDigest(row.cas_digest);
    // The CAS get re-hashes the stored bytes to the requested digest and raises a
    // typed integrity error on any mismatch — a corrupt row is never returned.
    const stored = await this.cas.get(input.orgId, casDigest);
    return {
      verificationArtifactId: input.verificationArtifactId,
      casDigest,
      mediaType: row.media_type,
      byteSize: toByteSize(row.byte_size),
      kind: row.kind,
      redactionClass: row.redaction_class,
      retentionClass: row.retention_class,
      bytes: stored.bytes,
    };
  }

  private async selectRow(client: QueryClient, orgId: string, id: string): Promise<StoredRow | undefined> {
    const result = await client.query<StoredRow>(
      `SELECT id, cas_digest, media_type, byte_size, kind, redaction_class, retention_class
         FROM verification_artifacts
        WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return result.rows[0];
  }

  private async assertProject(client: QueryClient, orgId: string, projectId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM projects WHERE org_id = $1 AND project_id = $2", [
      orgId,
      projectId,
    ]);
    if (result.rowCount !== 1) throw new CaptureProjectScopeError(orgId, projectId);
  }
}
