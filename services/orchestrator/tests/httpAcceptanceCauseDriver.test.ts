import { describe, expect, it, vi } from "vitest";
import {
  HttpAcceptanceCauseDriver,
  type CauseDriveInput,
  type HttpFetch,
} from "../src/engine/verification/acceptance/index.js";

function input(overrides: Partial<CauseDriveInput> = {}): CauseDriveInput {
  return {
    orgId: "org-a3",
    projectId: "project-a3",
    behaviorRevisionId: "behavior-a3",
    integrationNodeId: "inode-a3",
    runId: "run-a3",
    deliveryRunId: "delivery-a3",
    deploymentFingerprint: "deploy-a3",
    cause: { causeId: "send", surface: "api", action: "send-message" },
    correlations: [{ causeId: "send", observer: "slack", provider: "slack", requireCorrelationId: true }],
    plan: {
      planId: "plan-a3",
      behaviorRevisionId: "behavior-a3",
      requiredSurfaces: ["api"],
      assertions: [],
      fixtures: [],
      examples: [],
      executionMatrix: {
        browser: [],
        viewport: [],
        locale: [],
        theme: [],
        motion: [],
        contrast: [],
        device: [],
      },
      httpProbes: [{ probeId: "send-message", method: "POST", path: "/messages", body: { body: "hello" } }],
    },
    httpProbes: [{ probeId: "send-message", method: "POST", path: "/messages", body: { body: "hello" } }],
    ...overrides,
  };
}

function response() {
  return { status: 202, headers: { get: () => null }, text: async () => "" };
}

describe("HttpAcceptanceCauseDriver — A3 live trigger boundary", () => {
  it("drives the declared live action with an unforgeable correlation after its provider watermark", async () => {
    const fetchImpl = vi.fn<HttpFetch>().mockResolvedValue(response());
    const watermarkProbe = { captureWatermark: vi.fn<() => Promise<string>>().mockResolvedValue("1710000000.000001") };
    const driver = new HttpAcceptanceCauseDriver({
      resolveBaseUrl: { resolve: async () => ({ kind: "resolved", baseUrl: "https://release.example/" }) },
      watermarkProbe,
      fetchImpl,
      randomId: () => "fixed-id",
    });

    const fired = await driver.fireCause(input());

    expect(fired).toMatchObject({ causeId: "send", firedAtCursor: "1710000000.000001" });
    expect("correlationId" in fired && fired.correlationId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://release.example/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-tanren-correlation-id": expect.stringMatching(/^sha256:/u),
          "idempotency-key": expect.stringMatching(/^sha256:/u),
        }),
      }),
    );
  });

  it("FAIL-CLOSED: without a sealed delivery set it does not fire the external action", async () => {
    const fetchImpl = vi.fn<HttpFetch>().mockResolvedValue(response());
    const driver = new HttpAcceptanceCauseDriver({
      resolveBaseUrl: { resolve: async () => ({ kind: "resolved", baseUrl: "https://release.example/" }) },
      watermarkProbe: { captureWatermark: async () => "1" },
      fetchImpl,
    });

    const result = await driver.fireCause(input({ deliveryRunId: undefined }));

    expect(result).toMatchObject({ kind: "unavailable", outcome: "inconclusive_external" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: an absolute probe path outside the release origin cannot become an external trigger", async () => {
    const fetchImpl = vi.fn<HttpFetch>().mockResolvedValue(response());
    const driver = new HttpAcceptanceCauseDriver({
      resolveBaseUrl: { resolve: async () => ({ kind: "resolved", baseUrl: "https://release.example/" }) },
      watermarkProbe: { captureWatermark: async () => "1" },
      fetchImpl,
    });
    const escapedProbe = { probeId: "send-message", method: "POST", path: "https://evil.example/trigger" };

    const result = await driver.fireCause(input({ httpProbes: [escapedProbe] }));

    expect(result).toMatchObject({ kind: "unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: a rejected live action cannot be mistaken for a confirmed negative effect", async () => {
    const fetchImpl = vi.fn<HttpFetch>().mockResolvedValue({ ...response(), status: 500 });
    const driver = new HttpAcceptanceCauseDriver({
      resolveBaseUrl: { resolve: async () => ({ kind: "resolved", baseUrl: "https://release.example/" }) },
      watermarkProbe: { captureWatermark: async () => "1" },
      fetchImpl,
    });

    const result = await driver.fireCause(input());

    expect(result).toMatchObject({ kind: "unavailable", outcome: "inconclusive_external" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
