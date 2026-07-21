// in-22's fail-closed correlation join and proof producer. It extends the one
// in-19 A3 delivery seam: after the independent observation is already present,
// it seals a portable DSSE envelope through the shared PgProofSubstrate. Any
// missing or byte-mismatched key returns blocked and writes no proof row.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { canonicalJson, type CanonicalBody, type ProofBundleSealed, type ProofSubstrate } from "../../contracts/cas.js";
import type { DeliveryLineage } from "./stageModel.js";
import type {
  BehaviorVerdictEvidence,
  EvidenceCoordinate,
  GrantEvidence,
  IndependentObservation,
  IntegrationEvidenceReaders,
  RuntimeAttachment,
  SealedIntegrationCoordinate,
} from "./integrationEvidence.js";

const DSSE_VERSION = "integration-evidence.v1.dsse.json";
const DSSE_PAYLOAD_TYPE = "application/vnd.tanren.integration-evidence.v1+json";

export interface IntegrationEvidenceDsseSigner extends ProofSubstrate {
  signDsse(input: {
    readonly payloadType: string;
    readonly payload: Uint8Array;
  }): Promise<{ readonly keyId: string; readonly signature: string; readonly publicKeyPem: string }>;
}

export type ReadyEvidence = {
  readonly coordinate: SealedIntegrationCoordinate;
  readonly verdict: BehaviorVerdictEvidence;
  readonly observation: IndependentObservation;
  readonly attachment: RuntimeAttachment;
  readonly grant: GrantEvidence;
};

export type IntegrationEvidenceJoinResult =
  | { readonly kind: "ready"; readonly evidence: ReadyEvidence }
  | { readonly kind: "blocked"; readonly classification: string; readonly detail: string };

export type IntegrationEvidenceDsse = {
  readonly version: typeof DSSE_VERSION;
  readonly payloadType: typeof DSSE_PAYLOAD_TYPE;
  readonly payload: string;
  readonly signatures: readonly { readonly keyid: string; readonly sig: string }[];
  readonly publicKeyPem: string;
  readonly bundle: {
    readonly bundleId: string;
    readonly bundleDigest: string;
    readonly proofRoot: string;
    readonly bytesDigest: string;
    readonly signingKeyId: string;
    readonly rootSignature: string;
    readonly members: readonly {
      readonly bundleUnitId: string;
      readonly unitDigest: string;
      readonly kind: string;
      readonly verdict: string;
      readonly ordinal: number;
    }[];
    readonly bindings: Record<string, string>;
  };
};

export type IntegrationEvidenceAttestationResult =
  | { readonly kind: "sealed"; readonly count: number }
  | { readonly kind: "blocked"; readonly classification: string; readonly detail: string };

export class IntegrationEvidenceAttester {
  public constructor(
    private readonly pool: pg.Pool,
    private readonly readers: IntegrationEvidenceReaders,
    private readonly proofSubstrate: IntegrationEvidenceDsseSigner,
  ) {}

  public async attest(input: {
    readonly lineage: DeliveryLineage;
    readonly deliveryRunId: string;
    readonly deploymentId: string;
  }): Promise<IntegrationEvidenceAttestationResult> {
    const coordinate = evidenceCoordinate(input);
    if (!(await this.readers.readAuthorizedDelivery(coordinate))) {
      return blocked("evidence_unavailable", "authorized merge coordinate is absent or mismatched");
    }
    const sealed = await this.readers.readSealedCoordinates(coordinate);
    if (sealed.length === 0)
      return blocked("evidence_unavailable", "no release-required sealed integration coordinates exist");
    const [attachments, deployments] = await Promise.all([
      this.readers.readRuntimeAttachments(coordinate),
      this.readers.readDeployment(coordinate),
    ]);
    const ready: ReadyEvidence[] = [];
    for (const item of sealed) {
      const result = await this.joinOne(coordinate, item, attachments, deployments);
      if (result.kind === "blocked") {
        await this.recordFailure(coordinate, item, result.classification);
        return result;
      }
      ready.push(result.evidence);
    }
    for (const item of ready) await this.sealOne(coordinate, item);
    return { kind: "sealed", count: ready.length };
  }

  private async joinOne(
    input: EvidenceCoordinate,
    coordinate: SealedIntegrationCoordinate,
    attachments: readonly RuntimeAttachment[],
    deployments: readonly { readonly deploymentId: string; readonly deploySha: string }[],
  ): Promise<IntegrationEvidenceJoinResult> {
    const [verdicts, observations, grant] = await Promise.all([
      this.readers.readBehaviorVerdicts(input, coordinate.behaviorRevisionId),
      this.readers.readIndependentObservations(input, coordinate),
      this.readers.readGrant(input, coordinate),
    ]);
    return assembleIntegrationEvidence({ input, coordinate, attachments, deployments, verdicts, observations, grant });
  }

  private async sealOne(input: EvidenceCoordinate, evidence: ReadyEvidence): Promise<void> {
    const body = evidenceBody(input, evidence);
    const issuedAt = evidence.observation.observedAt.toISOString();
    const refs = await this.proofSubstrate.ingestUnits({
      orgId: input.orgId,
      projectId: input.projectId,
      drafts: [{ kind: "runtime_behavior", verdict: "passed", subjectId: evidence.coordinate.bindingId, body }],
    });
    const member = refs[0];
    if (member === undefined) throw new Error("integration evidence proof substrate returned no proof unit");
    const bundle = await this.proofSubstrate.constructBundle({
      orgId: input.orgId,
      projectId: input.projectId,
      members: refs,
      bindings: {
        integrationNodeId: `integration-evidence:${input.deliveryRunId}`,
        memberSetHash: member.digest,
        preparedHeadSha: input.mergeSha,
        jjTreeId: input.mergeSha,
        artifactDigest: member.digest,
        expectedMainSha: input.mergeSha,
        issuedAt,
        expiresAt: issuedAt,
        nonce: `a3:${input.deliveryRunId}:${evidence.coordinate.bindingId}:${String(evidence.coordinate.bindingGeneration)}`,
      },
    });
    const verification = await this.proofSubstrate.verify(bundle);
    if (!verification.valid)
      throw new Error(`integration evidence proof bundle did not verify: ${verification.reason ?? "unknown"}`);
    await this.proofSubstrate.persistBundle(bundle);
    const dsse = await buildDsse(body, bundle, this.proofSubstrate);
    await runWithOrgScope(this.pool, input.orgId, (client) =>
      client.query(
        `INSERT INTO integration_validation_proofs (
           org_id, id, project_id, spec_id, behavior_revision_id, behavior_verdict_id, proof_unit_digest,
           requirement_id, binding_id, binding_generation, delivery_run_id, deployment_id, deploy_sha,
           probe_version, correlation_id, trigger_digest, sanitized_observation, provider_receipt_id,
           provider_receipt_at, verdict, evidence_digest, signature, channel_template_digest,
           negative_control_checklist, bundle_id, bundle_digest, bundle_bytes_digest, signing_key_id,
           dsse_bundle, fresh_until
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb,
           $18, $19, 'passed', $20, $21, $22, $23::jsonb, $24, $25, $26, $27, $28::jsonb, $29
         ) ON CONFLICT (org_id, project_id, behavior_revision_id, binding_id, binding_generation,
                         deploy_sha, probe_version, correlation_id) DO NOTHING`,
        [
          input.orgId,
          proofId(input, evidence),
          input.projectId,
          input.specId,
          evidence.coordinate.behaviorRevisionId,
          evidence.verdict.behaviorVerdictId,
          member.digest,
          evidence.coordinate.requirementId,
          evidence.coordinate.bindingId,
          evidence.coordinate.bindingGeneration,
          input.deliveryRunId,
          input.deploymentId,
          input.mergeSha,
          `in-19.a3.${evidence.observation.observer}.v1`,
          evidence.observation.correlationId,
          evidence.observation.correlationId,
          JSON.stringify(sanitizedObservation(evidence.observation)),
          evidence.observation.providerReceiptId,
          evidence.observation.observedAt,
          member.digest,
          dsse.signatures[0]?.sig ?? "",
          evidence.coordinate.channelTemplateDigest,
          JSON.stringify(negativeControls()),
          bundle.bundleId,
          bundle.bundleDigest,
          bundle.bytesDigest,
          bundle.signingKeyId,
          JSON.stringify(dsse),
          evidence.observation.observedAt,
        ],
      ),
    );
  }

  private async recordFailure(
    input: EvidenceCoordinate,
    coordinate: SealedIntegrationCoordinate,
    classification: string,
  ): Promise<void> {
    const allowed =
      classification === "grant_revoked" || classification === "correlation_join_mismatch"
        ? classification
        : "evidence_unavailable";
    await runWithOrgScope(this.pool, input.orgId, (client) =>
      client.query(
        `INSERT INTO integration_evidence_failures
           (org_id, id, project_id, delivery_run_id, binding_id, binding_generation, classification, redacted_detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'integration evidence could not seal; sensitive provider detail redacted')
         ON CONFLICT (org_id, delivery_run_id, binding_id, binding_generation, classification) DO NOTHING`,
        [
          input.orgId,
          `integration-evidence-failure:${input.deliveryRunId}:${coordinate.bindingId}:` +
            `${String(coordinate.bindingGeneration)}:${allowed}`,
          input.projectId,
          input.deliveryRunId,
          coordinate.bindingId,
          coordinate.bindingGeneration,
          allowed,
        ],
      ),
    );
  }
}

/** The byte-for-byte correlation assembler; any non-unique or mismatched key blocks. */
export function assembleIntegrationEvidence(input: {
  readonly input: EvidenceCoordinate;
  readonly coordinate: SealedIntegrationCoordinate;
  readonly attachments: readonly RuntimeAttachment[];
  readonly deployments: readonly { readonly deploymentId: string; readonly deploySha: string }[];
  readonly verdicts: readonly BehaviorVerdictEvidence[];
  readonly observations: readonly IndependentObservation[];
  readonly grant: GrantEvidence | undefined;
}): IntegrationEvidenceJoinResult {
  const { coordinate, attachments, deployments, verdicts, observations, grant } = input;
  const attachment = only(
    attachments.filter(
      (row) =>
        row.bindingId === coordinate.bindingId &&
        row.bindingGeneration === coordinate.bindingGeneration &&
        row.deploySha === input.input.mergeSha,
    ),
  );
  if (attachment === undefined) {
    return blocked(
      "correlation_join_mismatch",
      "sealed binding generation was not attached before the authorized deploy",
    );
  }
  const deployment = only(
    deployments.filter(
      (row) => row.deploymentId === input.input.deploymentId && row.deploySha === input.input.mergeSha,
    ),
  );
  if (deployment === undefined) {
    return blocked("correlation_join_mismatch", "deployed artifact does not resolve to the authorized merge SHA");
  }
  if (grant?.status === "revoked") return blocked("grant_revoked", "integration grant is revoked; detail redacted");
  if (grant === undefined || grant.status !== "active" || grant.generation !== coordinate.grantGeneration) {
    return blocked("evidence_unavailable", "sealed integration grant is not active at its recorded generation");
  }
  const verdict = only(verdicts);
  if (verdict === undefined)
    return blocked("correlation_join_mismatch", "exactly one passed post-merge behavior verdict is required");
  const observation = only(observations);
  if (
    observation === undefined ||
    observation.classification !== "ok" ||
    observation.occurrenceCount !== 1 ||
    observation.correlationId === "" ||
    observation.providerReceiptId === ""
  ) {
    return blocked("correlation_join_mismatch", "exactly one independent A3 observation is required");
  }
  return { kind: "ready", evidence: { coordinate, verdict, observation, attachment, grant } };
}

async function buildDsse(
  body: CanonicalBody,
  bundle: ProofBundleSealed,
  signer: IntegrationEvidenceDsseSigner,
): Promise<IntegrationEvidenceDsse> {
  const payload = new TextEncoder().encode(canonicalJson(body));
  const signature = await signer.signDsse({ payloadType: DSSE_PAYLOAD_TYPE, payload });
  return {
    version: DSSE_VERSION,
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64url"),
    signatures: [{ keyid: signature.keyId, sig: signature.signature }],
    publicKeyPem: signature.publicKeyPem,
    bundle: {
      bundleId: bundle.bundleId,
      bundleDigest: bundle.bundleDigest,
      proofRoot: bundle.proofRoot,
      bytesDigest: bundle.bytesDigest,
      signingKeyId: bundle.signingKeyId,
      rootSignature: Buffer.from(bundle.rootSignature).toString("base64url"),
      members: bundle.members.map((member) => ({ ...member })),
      bindings: { ...bundle.bindings },
    },
  };
}

function evidenceCoordinate(input: {
  readonly lineage: DeliveryLineage;
  readonly deliveryRunId: string;
  readonly deploymentId: string;
}): EvidenceCoordinate {
  return {
    orgId: input.lineage.orgId,
    projectId: input.lineage.projectId,
    runId: input.lineage.runId,
    specId: input.lineage.specId,
    deliveryRunId: input.deliveryRunId,
    mergeSha: input.lineage.mergeSha,
    deploymentId: input.deploymentId,
  };
}

function evidenceBody(input: EvidenceCoordinate, evidence: ReadyEvidence): CanonicalBody {
  return {
    version: DSSE_VERSION,
    orgId: input.orgId,
    projectId: input.projectId,
    runId: input.runId,
    specId: input.specId,
    deliveryRunId: input.deliveryRunId,
    authorizedMergeSha: input.mergeSha,
    deploymentId: input.deploymentId,
    requirementId: evidence.coordinate.requirementId,
    bindingId: evidence.coordinate.bindingId,
    bindingGeneration: evidence.coordinate.bindingGeneration,
    channelTemplateDigest: evidence.coordinate.channelTemplateDigest,
    behaviorRevisionId: evidence.coordinate.behaviorRevisionId,
    behaviorVerdictId: evidence.verdict.behaviorVerdictId,
    correlationId: evidence.observation.correlationId,
    providerReceiptId: evidence.observation.providerReceiptId,
    observation: sanitizedObservation(evidence.observation),
    negativeControlChecklist: negativeControls(),
  };
}

function sanitizedObservation(observation: IndependentObservation): CanonicalBody {
  return {
    observationId: observation.observationId,
    observer: observation.observer,
    provider: observation.provider,
    cursor: observation.cursor,
    occurrenceCount: observation.occurrenceCount,
    classification: observation.classification,
    providerReceiptId: observation.providerReceiptId,
  };
}

function negativeControls(): CanonicalBody {
  return {
    authorizedMergeShaMatchesDeployment: true,
    bindingGenerationAttachedBeforeDeploy: true,
    correlationMatchesIndependentObservation: true,
    independentObservationIsExactlyOne: true,
    grantActiveAtSeal: true,
  };
}

function proofId(input: EvidenceCoordinate, evidence: ReadyEvidence): string {
  return (
    `integration-proof:${input.deliveryRunId}:${evidence.coordinate.bindingId}:` +
    `${String(evidence.coordinate.bindingGeneration)}:${evidence.observation.correlationId}`
  );
}

function only<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function blocked(
  classification: string,
  detail: string,
): Extract<IntegrationEvidenceAttestationResult, { readonly kind: "blocked" }> {
  return { kind: "blocked", classification, detail };
}
