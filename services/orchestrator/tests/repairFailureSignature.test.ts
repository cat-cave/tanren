import { describe, expect, it } from "vitest";
import { repairFailureSignature } from "../src/engine/workflow/repairFailureSignature.js";

function signature(input: {
  readonly errorCode: string;
  readonly attemptNumber: number;
  readonly timestamp: string;
  readonly runId: string;
  readonly traceId: string;
  readonly artifactIds: readonly string[];
}): string {
  return repairFailureSignature({
    contractId: "contract_checkout_payment",
    contractHash: "sha256:" + "a".repeat(64),
    classification: "product_failure",
    assertions: [
      {
        expectedObservation: {
          status: 200,
          body: { errorClass: "none", errorCode: "none", nodeKind: "payment", stage: "checkout" },
        },
        observedObservation: {
          status: 502,
          body: {
            errorClass: "UpstreamTimeout",
            errorCode: input.errorCode,
            nodeKind: "payment",
            stage: "checkout",
            message: `attempt #${input.attemptNumber} failed in ${input.runId} at ${input.timestamp}`,
            execution: {
              attemptNumber: input.attemptNumber,
              runId: input.runId,
              timestamp: input.timestamp,
              traceId: input.traceId,
            },
            artifactIds: input.artifactIds,
          },
          attemptNumber: input.attemptNumber,
          timestamp: input.timestamp,
          verificationRunId: input.runId,
        },
        outcome: "failed",
      },
    ],
  });
}

describe("repairFailureSignature", () => {
  it("uses only stable failure fields and differentiates genuine failures", () => {
    const first = signature({
      errorCode: "PAYMENT_GATEWAY_TIMEOUT",
      attemptNumber: 1,
      timestamp: "2026-07-19T10:00:00.000Z",
      runId: "vrun_550e8400-e29b-41d4-a716-446655440000",
      traceId: "5f9c9ee0-1dd0-4ee4-8af8-f77fdf1f8cbd",
      artifactIds: ["artifact_a", "artifact_b"],
    });
    const recurrence = signature({
      errorCode: "PAYMENT_GATEWAY_TIMEOUT",
      attemptNumber: 44,
      timestamp: "2026-07-20T11:11:11.111Z",
      runId: "vrun_982b3ec1-4dce-4148-b22c-d676e39d8b64",
      traceId: "0eaa0267-bf10-4ef0-93a6-dcb60101522a",
      artifactIds: ["artifact_z", "artifact_y"],
    });
    const differentFailure = signature({
      errorCode: "PAYMENT_GATEWAY_REJECTED",
      attemptNumber: 45,
      timestamp: "2026-07-21T12:12:12.222Z",
      runId: "vrun_95e04224-1ed0-4ebb-908e-58e0f34294bb",
      traceId: "3bf4b947-25de-480d-b3ed-42aa10e214cd",
      artifactIds: ["artifact_q"],
    });

    expect(recurrence).toBe(first);
    expect(differentFailure).not.toBe(first);
  });
});
