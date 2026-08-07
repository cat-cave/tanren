import { describe, expect, it } from "vitest";
import { contentDigestOf, type CasByteStore, type Digest } from "../src/engine/contracts/cas.js";
import type {
  AdapterUnavailableResult,
  DriverExecutionResult,
} from "../src/engine/contracts/runtimeVerificationAdapters.js";
import type { SymptomContractV1 } from "../src/engine/contracts/symptomContract.js";
import type {
  SymptomProbeDriver,
  SymptomProbeEvidence,
  SymptomProbeExecution,
  SymptomVerificationInput,
} from "../src/engine/contracts/symptomProbe.js";
import { symptomObservationHash } from "../src/engine/contracts/symptomProbe.js";
import {
  MultimodalSymptomProbe,
  type MultimodalSymptomRuntime,
  type MultimodalSymptomRuntimeInput,
} from "../src/engine/probes/multimodalSymptomProbe.js";
import { SymptomProbeAdapter } from "../src/engine/probes/symptomProbeAdapter.js";

const orgId = "org-a";
const projectId = "project-a";
const contractId = "contract-a";
const verificationRunId = "run-a";
const planId = `sha256:${"a".repeat(64)}` as Digest;
const contextHash = `sha256:${"b".repeat(64)}` as Digest;
const artifactDigest = `sha256:${"c".repeat(64)}` as Digest;
const domBytes = new Uint8Array([1, 2, 3]);
const networkBytes = new Uint8Array([4, 5, 6]);
const domRef = { kind: "dom", mediaType: "text/html" } as const;
const networkRef = { kind: "network", mediaType: "application/json" } as const;

const target = {
  kind: "multimodal_browser",
  version: 1,
  url: "http://live.example.test/symptom",
  planId,
  runtimeBehaviorContextHash: contextHash,
  assertions: [
    {
      assertionId: "dom-title",
      observationKind: "dom",
      subject: "document.title",
      comparisonOperator: "equals",
      expected: "Tanren",
      evidence: [domRef],
    },
    {
      assertionId: "http-status",
      observationKind: "http",
      subject: "response.status",
      comparisonOperator: "equals",
      expected: 200,
      evidence: [networkRef],
    },
  ],
  evidence: [
    { ...domRef, redactionClass: "none" },
    { ...networkRef, redactionClass: "none" },
  ],
} as const;

const contract = (overrides: Record<string, unknown> = {}): SymptomContractV1 => ({
  version: 1,
  issueLoopId: "loop-a",
  target: { ...target, ...overrides },
  expectedFailingObservation: {},
  expectedCorrectedObservation: {},
  proofPolicy: "observational",
  sourceRevision: null,
  baselineRequired: false,
});

const binding = {
  orgId,
  projectId,
  contractId,
  verificationRunId,
  artifactDigest,
  planId,
  runtimeBehaviorContextHash: contextHash,
  releaseInstanceId: "release-a",
};

function manualExecution(
  options: {
    readonly title?: string;
    readonly domEvidence?: SymptomProbeEvidence;
    readonly networkEvidence?: SymptomProbeEvidence;
    readonly domManifestDigest?: Digest;
    readonly networkManifestDigest?: Digest;
    readonly evidence?: readonly SymptomProbeEvidence[];
    readonly observedPlanId?: Digest;
  } = {},
): SymptomProbeExecution {
  const title = options.title ?? "Tanren";
  const domDigest = options.domManifestDigest ?? contentDigestOf(domBytes);
  const networkDigest = options.networkManifestDigest ?? contentDigestOf(networkBytes);
  const evidence = options.evidence ?? [
    options.domEvidence ?? { kind: domRef.kind, mediaType: domRef.mediaType, bytes: domBytes, redactionClass: "none" },
    options.networkEvidence ?? {
      kind: networkRef.kind,
      mediaType: networkRef.mediaType,
      bytes: networkBytes,
      redactionClass: "none",
    },
  ];
  const assertions = [
    {
      assertionId: "dom-title",
      observationKind: "dom",
      subject: "document.title",
      expected: "Tanren",
      actual: title,
      outcome: title === "Tanren" ? "passed" : "failed",
      evidenceDigests: [domDigest],
    },
    {
      assertionId: "http-status",
      observationKind: "http",
      subject: "response.status",
      expected: 200,
      actual: 200,
      outcome: "passed",
      evidenceDigests: [networkDigest],
    },
  ] as const;
  return {
    observedObservation: {
      version: "multimodal_symptom_observation.v1",
      planId: options.observedPlanId ?? planId,
      runtimeBehaviorContextHash: contextHash,
      outcome: title === "Tanren" ? "passed" : "failed",
      assertions,
      evidence: [
        { ...domRef, digest: domDigest },
        { ...networkRef, digest: networkDigest },
      ],
    },
    evidence,
    timingMs: 4,
    outcome: title === "Tanren" ? "passed" : "failed",
  };
}

class RuntimeFake implements MultimodalSymptomRuntime {
  public calls = 0;

  public constructor(private readonly result: DriverExecutionResult | AdapterUnavailableResult) {}

  public async execute(
    input: MultimodalSymptomRuntimeInput,
  ): Promise<DriverExecutionResult | AdapterUnavailableResult> {
    this.calls += 1;
    void input;
    return this.result;
  }
}

class CasFake implements CasByteStore {
  public writes = 0;

  public async put(input: { readonly orgId: string; readonly bytes: Uint8Array; readonly mediaType: string }) {
    this.writes += 1;
    return { digest: contentDigestOf(input.bytes), byteSize: input.bytes.byteLength, mediaType: input.mediaType };
  }

  public async get(): Promise<never> {
    throw new Error("unused");
  }

  public async has(): Promise<boolean> {
    return false;
  }
}

class EvidenceFake {
  public artifacts = 0;
  public assertions = 0;
  public persisted: unknown[] = [];

  public async recordArtifact(input: {
    readonly casDigest: Digest;
    readonly byteSize: number;
    readonly mediaType: string;
  }) {
    this.artifacts += 1;
    return {
      id: `artifact-${this.artifacts}`,
      casDigest: input.casDigest,
      byteSize: input.byteSize,
      mediaType: input.mediaType,
    };
  }

  public async recordAssertion(input: { readonly sampleData: Record<string, unknown> }) {
    this.assertions += 1;
    this.persisted.push(input.sampleData);
    return { id: "assertion-a" };
  }
}

function staticDriver(execution: SymptomProbeExecution): SymptomProbeDriver {
  return {
    async execute() {
      return execution;
    },
  };
}

function adapter(driver: SymptomProbeDriver, cas = new CasFake(), evidence = new EvidenceFake()) {
  return {
    adapter: new SymptomProbeAdapter({} as never, driver, {
      cas,
      evidence: evidence as never,
      eventStore: { append: async () => {} } as never,
    }),
    cas,
    evidence,
  };
}

function verificationInput(overrides: Partial<SymptomVerificationInput> = {}): SymptomVerificationInput {
  return {
    orgId,
    projectId,
    contractId,
    contract: contract(),
    verificationRunId,
    expectedObservation: {},
    runtimeBinding: binding,
    ...overrides,
  };
}

describe("fail-closed multimodal symptom boundary", () => {
  it("derives a rich verdict from every assertion, so HTTP 200 cannot mask a DOM defect", async () => {
    const runtime = new RuntimeFake({
      kind: "executed",
      observations: [
        { observationKind: "dom", subject: "document.title", value: "Broken", observedAt: "2026-08-07T00:00:00.000Z" },
        { observationKind: "http", subject: "response.status", value: 200, observedAt: "2026-08-07T00:00:00.000Z" },
      ],
      providerChecksums: [],
      capture: [
        { kind: "dom", mediaType: domRef.mediaType, bytes: domBytes, redactionClass: "none" },
        { kind: "network", mediaType: networkRef.mediaType, bytes: networkBytes, redactionClass: "none" },
      ],
    });
    const result = await new MultimodalSymptomProbe(runtime, async () => "http://live.example.test").execute({
      orgId,
      projectId,
      contractId,
      contract: contract(),
      verificationRunId,
      runtimeBinding: binding,
    });
    expect(result.outcome).toBe("failed");
    expect(result.observedObservation).toMatchObject({
      outcome: "failed",
      assertions: [{ outcome: "failed" }, { outcome: "passed" }],
    });
    expect(runtime.calls).toBe(1);
  });

  it("recomputes the observation digest before persisting a valid rich proof", async () => {
    const execution = manualExecution();
    const result = adapter(staticDriver(execution));
    const stored = await result.adapter.runVerification(verificationInput());
    expect(stored.outcome).toBe("passed");
    expect(stored.observedHash).toBe(symptomObservationHash(execution.observedObservation));
    expect(result.cas.writes).toBe(3);
  });

  it.each([
    [
      "missing",
      () =>
        manualExecution({
          evidence: [
            { kind: networkRef.kind, mediaType: networkRef.mediaType, bytes: networkBytes, redactionClass: "none" },
          ],
        }),
    ],
    [
      "duplicate",
      () =>
        manualExecution({
          evidence: [
            { kind: domRef.kind, mediaType: domRef.mediaType, bytes: domBytes, redactionClass: "none" },
            { kind: domRef.kind, mediaType: domRef.mediaType, bytes: domBytes, redactionClass: "none" },
            { kind: networkRef.kind, mediaType: networkRef.mediaType, bytes: networkBytes, redactionClass: "none" },
          ],
        }),
    ],
    [
      "mutated",
      () =>
        manualExecution({
          domEvidence: {
            kind: domRef.kind,
            mediaType: domRef.mediaType,
            bytes: new Uint8Array([9, 9, 9]),
            redactionClass: "none",
          },
        }),
    ],
    ["forged", () => manualExecution({ domManifestDigest: `sha256:${"f".repeat(64)}` as Digest })],
  ] as const)("rejects %s evidence with zero proof effects", async (_name, makeExecution) => {
    const cas = new CasFake();
    const evidence = new EvidenceFake();
    const result = adapter(staticDriver(makeExecution()), cas, evidence);
    await expect(result.adapter.runVerification(verificationInput())).rejects.toThrow(/multimodal/u);
    expect(cas.writes).toBe(0);
    expect(evidence.artifacts).toBe(0);
    expect(evidence.assertions).toBe(0);
  });

  it("rejects a plan/context mismatch before the runtime or proof effects", async () => {
    const runtime = new RuntimeFake({ kind: "executed", observations: [], providerChecksums: [], capture: [] });
    const probe = new MultimodalSymptomProbe(runtime);
    const result = adapter(probe);
    await expect(
      result.adapter.runVerification(verificationInput({ runtimeBinding: { ...binding, planId: contextHash } })),
    ).rejects.toThrow(/multimodal/u);
    expect(runtime.calls).toBe(0);
    expect(result.cas.writes).toBe(0);
    expect(result.evidence.artifacts).toBe(0);
    expect(result.evidence.assertions).toBe(0);
  });

  it("keeps secret-bearing unavailable diagnostics out of persisted proof material", async () => {
    const runtime = new RuntimeFake({
      kind: "unavailable",
      outcome: "inconclusive_infrastructure",
      reason: "provider stack token=secret",
    });
    const result = adapter(new MultimodalSymptomProbe(runtime));
    await expect(result.adapter.runVerification(verificationInput())).resolves.toMatchObject({
      outcome: "inconclusive",
    });
    expect(JSON.stringify(result.evidence.persisted)).not.toContain("token=secret");
    expect(JSON.stringify(result.evidence.persisted)).toContain("inconclusive_infrastructure");
  });

  it("rejects a malformed locked assertion before calling the runtime", async () => {
    const runtime = new RuntimeFake({ kind: "executed", observations: [], providerChecksums: [], capture: [] });
    const probe = new MultimodalSymptomProbe(runtime);
    const result = adapter(probe);
    await expect(
      result.adapter.runVerification(
        verificationInput({
          contract: contract({
            assertions: [{ ...target.assertions[0], evidence: [] }, target.assertions[1]],
          }),
        }),
      ),
    ).rejects.toThrow(/evidence/u);
    expect(runtime.calls).toBe(0);
    expect(result.cas.writes).toBe(0);
  });
});
