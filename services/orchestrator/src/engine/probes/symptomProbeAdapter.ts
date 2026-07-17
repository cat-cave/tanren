import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgCasByteStore } from "../cas/pgCasByteStore.js";
import type { CasByteStore, Digest } from "../contracts/cas.js";
import {
  canonicalSymptomObservationBytes,
  parseSymptomContract,
  symptomObservationHash,
  type SymptomBaselineInput,
  type SymptomBaselineResult,
  type SymptomProbeDriver,
  type SymptomProbeEvidence,
  type SymptomVerificationInput,
  type SymptomVerificationResult,
} from "../contracts/symptomProbe.js";
import type { AppendEventInput, EventStore } from "../eventStore.js";
import { PgEventStore } from "../eventStore.js";
import { SymptomEvidenceStore } from "../repositories/symptomEvidence.js";

function nonnegativeTiming(timingMs: number): number {
  if (!Number.isSafeInteger(timingMs) || timingMs < 0) throw new Error("symptom probe timingMs must be nonnegative");
  return timingMs;
}

type SymptomEvent =
  | Omit<AppendEventInput<"symptom.baseline.started">, "orgId" | "projectId">
  | Omit<AppendEventInput<"symptom.baseline.observed">, "orgId" | "projectId">;

/** Runs one immutable contract against the current deployment and records proof. */
export class SymptomProbeAdapter {
  private readonly cas: CasByteStore;
  private readonly evidence: SymptomEvidenceStore;
  private readonly eventStore: EventStore;

  public constructor(
    private readonly pool: pg.Pool,
    private readonly driver: SymptomProbeDriver,
    dependencies?: {
      readonly cas?: CasByteStore;
      readonly evidence?: SymptomEvidenceStore;
      readonly eventStore?: EventStore;
    },
  ) {
    this.cas = dependencies?.cas ?? new PgCasByteStore(pool);
    this.evidence = dependencies?.evidence ?? new SymptomEvidenceStore(pool);
    this.eventStore = dependencies?.eventStore ?? new PgEventStore(pool);
  }

  public async runBaseline(input: SymptomBaselineInput): Promise<SymptomBaselineResult> {
    const contract = parseSymptomContract(input.contract);
    await this.emitBaselineStarted(input, contract.issueLoopId);
    const result = await this.runVerification({
      ...input,
      contract,
      expectedObservation: contract.expectedFailingObservation,
    });
    const baselineOutcome =
      result.outcome === "inconclusive"
        ? "inconclusive"
        : result.outcome === "passed"
          ? "reproduced"
          : "not_reproduced";
    await this.emitBaselineObserved(
      input,
      contract.issueLoopId,
      baselineOutcome,
      result.evidence.map((item) => item.id),
    );
    return { ...result, baselineOutcome };
  }

  /**
   * Execute the SP·5 probe against a caller-supplied assertion target.
   *
   * Baseline reproduction passes the original failing observation; production
   * verification passes the corrected observation. Stages own their frozen
   * lifecycle events, while this shared path owns observations, CAS evidence,
   * and `symptom.assertion.recorded`.
   */
  public async runVerification(input: SymptomVerificationInput): Promise<SymptomVerificationResult> {
    const contract = parseSymptomContract(input.contract);
    const execution = await this.driver.execute({
      orgId: input.orgId,
      projectId: input.projectId,
      contract,
      verificationRunId: input.verificationRunId,
    });
    const expectedHash = symptomObservationHash(input.expectedObservation);
    const observedHash = symptomObservationHash(execution.observedObservation);
    const timingMs = nonnegativeTiming(execution.timingMs);
    const outcome =
      execution.outcome === "inconclusive" ? "inconclusive" : expectedHash === observedHash ? "passed" : "failed";
    const evidence = await this.captureEvidence(input, execution.observedObservation, execution.evidence);
    const assertion = await this.evidence.recordAssertion({
      orgId: input.orgId,
      projectId: input.projectId,
      issueLoopId: contract.issueLoopId,
      verificationRunId: input.verificationRunId,
      expectedHash,
      observedHash,
      outcome,
      timingMs,
      sampleData: {
        expectedObservation: input.expectedObservation,
        observedObservation: execution.observedObservation,
        evidenceArtifactIds: evidence.map((item) => item.id),
      },
    });
    return {
      orgId: input.orgId,
      projectId: input.projectId,
      issueLoopId: contract.issueLoopId,
      contractId: input.contractId,
      verificationRunId: input.verificationRunId,
      expectedHash,
      observedHash,
      outcome,
      timingMs,
      evidence,
      assertionId: assertion.id,
    };
  }

  private async captureEvidence(
    input: SymptomBaselineInput,
    observation: Record<string, unknown>,
    probeEvidence: readonly SymptomProbeEvidence[],
  ) {
    const allEvidence = [
      ...probeEvidence,
      {
        kind: "symptom_observation",
        mediaType: "application/json",
        bytes: canonicalSymptomObservationBytes(observation),
        redactionClass: "none" as const,
      },
    ];
    const captured = [] as Array<{ id: string; digest: Digest; byteSize: number; mediaType: string }>;
    for (const item of allEvidence) {
      const artifact = await this.cas.put({ orgId: input.orgId, bytes: item.bytes, mediaType: item.mediaType });
      const link = await this.evidence.recordArtifact({
        orgId: input.orgId,
        projectId: input.projectId,
        verificationRunId: input.verificationRunId,
        casDigest: artifact.digest,
        kind: item.kind,
        mediaType: artifact.mediaType,
        byteSize: artifact.byteSize,
        redactionClass: item.redactionClass,
        retentionClass: item.retentionClass,
      });
      captured.push({ id: link.id, digest: link.casDigest, byteSize: link.byteSize, mediaType: link.mediaType });
    }
    return captured;
  }

  private async emitBaselineStarted(input: SymptomBaselineInput, issueLoopId: string): Promise<void> {
    await this.emit(input, {
      eventType: "symptom.baseline.started",
      payload: {
        projectId: input.projectId,
        issueLoopId,
        contractId: input.contractId,
        verificationRunId: input.verificationRunId,
      },
    });
  }

  private async emitBaselineObserved(
    input: SymptomBaselineInput,
    issueLoopId: string,
    outcome: "reproduced" | "not_reproduced" | "inconclusive",
    evidenceArtifactIds: readonly string[],
  ): Promise<void> {
    await this.emit(input, {
      eventType: "symptom.baseline.observed",
      payload: {
        projectId: input.projectId,
        issueLoopId,
        contractId: input.contractId,
        verificationRunId: input.verificationRunId,
        outcome,
        evidenceArtifactIds: [...evidenceArtifactIds],
      },
    });
  }

  private async emit(input: SymptomBaselineInput, event: SymptomEvent): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, () =>
      this.eventStore.append({ ...event, orgId: input.orgId, projectId: input.projectId }),
    );
  }
}
