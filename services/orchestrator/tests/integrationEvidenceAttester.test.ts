import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  assembleIntegrationEvidence,
  IntegrationEvidenceAttester,
  type IntegrationEvidenceDsseSigner,
} from "../src/engine/postMerge/delivery/integrationEvidenceAttester.js";
import type { IntegrationEvidenceReaders } from "../src/engine/postMerge/delivery/integrationEvidence.js";

const SHA = "a".repeat(40);

function evidenceInput(overrides: { deploySha?: string; attachmentSha?: string } = {}) {
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
      channelTemplateDigest: `sha256:${"b".repeat(64)}`,
      observer: "slack",
      provider: "slack",
    },
    attachments: [{ bindingId: "binding-evidence", bindingGeneration: 4, deploySha: overrides.attachmentSha ?? SHA }],
    deployments: [{ deploymentId: "deployment-evidence", deploySha: overrides.deploySha ?? SHA }],
    verdicts: [{ behaviorVerdictId: "verdict-evidence" }],
    observations: [
      {
        correlationId: "correlation-evidence",
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
    expect(assembleIntegrationEvidence(evidenceInput()).kind).toBe("ready");
  });

  it("DECISIVE: deploy SHA mismatch blocks before any DSSE evidence can be ready", () => {
    const result = assembleIntegrationEvidence(evidenceInput({ deploySha: "b".repeat(40) }));
    expect(result).toMatchObject({ kind: "blocked", classification: "correlation_join_mismatch" });
  });

  it("DECISIVE: an attachment for the right generation after a different deploy coordinate blocks", () => {
    const result = assembleIntegrationEvidence(evidenceInput({ attachmentSha: "c".repeat(40) }));
    expect(result).toMatchObject({ kind: "blocked", classification: "correlation_join_mismatch" });
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
