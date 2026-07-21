import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  assembleIntegrationEvidence,
  deriveNegativeControlChecklist,
  IntegrationEvidenceAttester,
  type IntegrationEvidenceDsseSigner,
} from "../src/engine/postMerge/delivery/integrationEvidenceAttester.js";
import {
  PgIntegrationEvidenceReaders,
  type IntegrationEvidenceReaders,
} from "../src/engine/postMerge/delivery/integrationEvidence.js";
import { a3CorrelationId } from "../src/engine/verification/acceptance/httpCauseDriver.js";

const SHA = "a".repeat(40);
const ATTACHED_AT = new Date("2026-07-21T00:00:00.000Z");
const VERIFIED_AT = new Date("2026-07-21T00:01:00.000Z");

function evidenceInput(
  overrides: {
    verifiedSourceRef?: string;
    attachmentSha?: string;
    attachmentAt?: Date;
    verifiedAt?: Date;
    correlationId?: string;
    channelTemplateDigest?: string | null;
  } = {},
) {
  const causeOrdinal = 0;
  return {
    input: {
      orgId: "org-evidence",
      projectId: "project-evidence",
      runId: "run-evidence",
      specId: "spec-evidence",
      deliveryRunId: "delivery-evidence",
      mergeSha: SHA,
      deploymentId: "deployment-evidence",
    },
    coordinate: {
      requirementId: "requirement-evidence",
      bindingId: "binding-evidence",
      bindingGeneration: 4,
      behaviorRevisionId: "behavior-evidence",
      grantId: "grant-evidence",
      grantGeneration: 3,
      channelTemplateDigest:
        overrides.channelTemplateDigest === undefined ? `sha256:${"b".repeat(64)}` : overrides.channelTemplateDigest,
      observer: "slack",
      provider: "slack",
    },
    attachments: [
      {
        bindingId: "binding-evidence",
        bindingGeneration: 4,
        deploySha: overrides.attachmentSha ?? SHA,
        attachedAt: overrides.attachmentAt ?? ATTACHED_AT,
      },
    ],
    deployments: [
      {
        deploymentId: "deployment-evidence",
        verifiedSourceRef: overrides.verifiedSourceRef ?? SHA,
        verifiedAt: overrides.verifiedAt ?? VERIFIED_AT,
      },
    ],
    verdicts: [{ behaviorVerdictId: "verdict-evidence" }],
    observations: [
      {
        correlationId:
          overrides.correlationId ??
          a3CorrelationId({
            deliveryRunId: "delivery-evidence",
            behaviorRevisionId: "behavior-evidence",
            bindingId: "binding-evidence",
            bindingGeneration: 4,
            causeOrdinal,
          }),
        causeOrdinal,
        providerReceiptId: "receipt-evidence",
        observationId: "observation-evidence",
        observer: "slack",
        provider: "slack",
        cursor: "cursor-evidence",
        occurrenceCount: 1,
        classification: "ok",
        observedAt: new Date("2026-07-21T00:00:00.000Z"),
      },
    ],
    grant: { status: "active", generation: 3 },
  };
}

describe("integration evidence byte-for-byte assembler", () => {
  it("accepts exactly one complete, authorized correlation chain", () => {
    const result = assembleIntegrationEvidence(evidenceInput());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected complete evidence to be ready");
    expect(result.evidence.checklist).toEqual({
      authorizedMergeShaMatchesDeployment: true,
      bindingGenerationAttachedBeforeDeploy: true,
      correlationMatchesIndependentObservation: true,
      independentObservationIsExactlyOne: true,
      exactlyOnePassedBehaviorVerdict: true,
      grantActiveAtSeal: true,
    });
  });

  it("DECISIVE: verified deploy SHA mismatch blocks before any DSSE evidence can be ready", () => {
    const result = assembleIntegrationEvidence(evidenceInput({ verifiedSourceRef: "b".repeat(40) }));
    expect(result).toMatchObject({ kind: "blocked", classification: "correlation_join_mismatch" });
  });

  it("DECISIVE: an attachment for the right generation after a different deploy coordinate blocks", () => {
    const result = assembleIntegrationEvidence(evidenceInput({ attachmentSha: "c".repeat(40) }));
    expect(result).toMatchObject({ kind: "blocked", classification: "correlation_join_mismatch" });
  });

  it("DECISIVE: verified deploy SHA mismatch seals nothing", async () => {
    const attempted = await attestFixture(evidenceInput({ verifiedSourceRef: "b".repeat(40) }));
    expect(attempted.result).toMatchObject({ kind: "blocked", classification: "correlation_join_mismatch" });
    expect(attempted.proofIngestCalls).toBe(0);
    expect(attempted.proofWrites).toHaveLength(0);
  });

  it("DECISIVE: attachment after verified deploy derives false and seals nothing", async () => {
    const fixture = evidenceInput({ attachmentAt: new Date("2026-07-21T00:02:00.000Z") });
    expect(deriveNegativeControlChecklist(fixture).bindingGenerationAttachedBeforeDeploy).toBe(false);
    const attempted = await attestFixture(fixture);
    expect(attempted.result).toMatchObject({ kind: "blocked", classification: "correlation_join_mismatch" });
    expect(attempted.proofIngestCalls).toBe(0);
    expect(attempted.proofWrites).toHaveLength(0);
  });

  it("DECISIVE: an A3 correlation that does not recompute from its cause coordinate seals nothing", async () => {
    const fixture = evidenceInput({ correlationId: `sha256:${"d".repeat(64)}` });
    expect(deriveNegativeControlChecklist(fixture).correlationMatchesIndependentObservation).toBe(false);
    const attempted = await attestFixture(fixture);
    expect(attempted.result).toMatchObject({ kind: "blocked", classification: "correlation_join_mismatch" });
    expect(attempted.proofIngestCalls).toBe(0);
    expect(attempted.proofWrites).toHaveLength(0);
  });

  it("DECISIVE: a missing channel/template digest seals nothing", async () => {
    const attempted = await attestFixture(evidenceInput({ channelTemplateDigest: null }));
    expect(attempted.result).toMatchObject({ kind: "blocked", classification: "evidence_unavailable" });
    expect(attempted.proofIngestCalls).toBe(0);
    expect(attempted.proofWrites).toHaveLength(0);
  });

  it("writes a fixed redacted durable refusal when the exact grant is revoked", async () => {
    const fixture = evidenceInput();
    const writes: Array<{ query: string; values: unknown[] | undefined }> = [];
    const pool = {
      connect: async () => ({
        query: async (query: string, values?: unknown[]) => {
          if (query.includes("integration_evidence_failures")) writes.push({ query, values });
          return { rows: [], rowCount: 1 };
        },
        release: () => {},
      }),
    } as unknown as pg.Pool;
    const readers: IntegrationEvidenceReaders = {
      readAuthorizedDelivery: async () => true,
      readSealedCoordinates: async () => [fixture.coordinate],
      readRuntimeAttachments: async () => fixture.attachments,
      readDeployment: async () => fixture.deployments,
      readBehaviorVerdicts: async () => fixture.verdicts,
      readIndependentObservations: async () => fixture.observations,
      readGrant: async () => ({ status: "revoked", generation: 3 }),
    };
    const attester = new IntegrationEvidenceAttester(pool, readers, {} as IntegrationEvidenceDsseSigner);
    const result = await attester.attest({
      lineage: {
        orgId: fixture.input.orgId,
        projectId: fixture.input.projectId,
        runId: fixture.input.runId,
        specId: fixture.input.specId,
        mergeSha: fixture.input.mergeSha,
      },
      deliveryRunId: fixture.input.deliveryRunId,
      deploymentId: fixture.input.deploymentId,
    });
    expect(result).toMatchObject({ kind: "blocked", classification: "grant_revoked" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.query).toContain("sensitive provider detail redacted");
    expect(writes[0]?.values).toContain("grant_revoked");
  });
});

describe("integration evidence verified deployment reader", () => {
  it("reads only the verified deployment sourceRef; a trigger cannot supply or override the SHA", async () => {
    const queries: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (query: string) => {
          queries.push(query);
          return query.includes("FROM events verified")
            ? {
                rows: [
                  {
                    deployment_id: "deployment-evidence",
                    verified_source_ref: SHA,
                    verified_at: VERIFIED_AT,
                  },
                ],
                rowCount: 1,
              }
            : { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
    } as unknown as pg.Pool;
    const rows = await new PgIntegrationEvidenceReaders(pool).readDeployment(evidenceInput().input);
    expect(rows).toEqual([{ deploymentId: "deployment-evidence", verifiedSourceRef: SHA, verifiedAt: VERIFIED_AT }]);
    const query = queries.find((value) => value.includes("FROM events verified"));
    expect(query).toContain("verified.payload->>'sourceRef' = $5");
    expect(query).not.toContain("deploy.triggered");
    expect(query).not.toContain("COALESCE");
  });
});

async function attestFixture(fixture: ReturnType<typeof evidenceInput>): Promise<{
  readonly result: Awaited<ReturnType<IntegrationEvidenceAttester["attest"]>>;
  readonly proofIngestCalls: number;
  readonly proofWrites: readonly { readonly query: string; readonly values: unknown[] | undefined }[];
}> {
  const writes: Array<{ query: string; values: unknown[] | undefined }> = [];
  const pool = {
    connect: async () => ({
      query: async (query: string, values?: unknown[]) => {
        writes.push({ query, values });
        return { rows: [], rowCount: 1 };
      },
      release: () => {},
    }),
  } as unknown as pg.Pool;
  let proofIngestCalls = 0;
  const signer = {
    ingestUnits: async () => {
      proofIngestCalls += 1;
      throw new Error("a blocked attestation must not ingest evidence");
    },
  } as unknown as IntegrationEvidenceDsseSigner;
  const readers: IntegrationEvidenceReaders = {
    readAuthorizedDelivery: async () => true,
    readSealedCoordinates: async () => [fixture.coordinate],
    readRuntimeAttachments: async () => fixture.attachments,
    readDeployment: async () => fixture.deployments,
    readBehaviorVerdicts: async () => fixture.verdicts,
    readIndependentObservations: async () => fixture.observations,
    readGrant: async () => fixture.grant,
  };
  const attester = new IntegrationEvidenceAttester(pool, readers, signer);
  const result = await attester.attest({
    lineage: {
      orgId: fixture.input.orgId,
      projectId: fixture.input.projectId,
      runId: fixture.input.runId,
      specId: fixture.input.specId,
      mergeSha: fixture.input.mergeSha,
    },
    deliveryRunId: fixture.input.deliveryRunId,
    deploymentId: fixture.input.deploymentId,
  });
  return {
    result,
    proofIngestCalls,
    proofWrites: writes.filter((write) => write.query.includes("integration_validation_proofs")),
  };
}
