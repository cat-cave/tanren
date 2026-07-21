// ds-7 — drive the land-time reader over hand-built conformance rows. This is
// deliberately DB-free: the injected org scope gives the gate a fake query
// client while exercising the same production resolver used at merge time.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { resolveDesignRenderGate } from "../src/engine/merge/designRenderLandGate.js";
import {
  designAdapterConformanceReceiptDigest,
  type DesignAdapterConformanceReceiptV1,
} from "../src/engine/design/system/adapterConformanceReceipt.js";

const DIGEST = `sha256:${"b".repeat(64)}`;
const ORG_ID = "org_ds7";
const PROJECT_ID = "project_ds7";

function requiredTargetContract(capabilities: readonly string[] = ["tokens"]): Record<string, unknown> {
  return {
    version: 2,
    domain: "saas-web",
    identity: "a conformance-gated project",
    intent: "publish only when its target proof is current",
    principles: [],
    constraints: [],
    personaRefs: [],
    behaviorRefs: [],
    dimensions: [],
    desiredSurfaces: [],
    targetProfiles: [{ target: "web-react", capabilities, required: true }],
    accessibilityPosture: { standard: "none", notes: "" },
    exportRequirements: [],
    acceptanceIntent: "",
    visualVerification: { enabled: false, imageDiffThreshold: 0.01 },
  };
}

function passedReceipt(capabilities: readonly string[] = ["tokens"]): DesignAdapterConformanceReceiptV1 {
  return {
    version: 1,
    schemaVersion: "design_adapter_conformance.v1",
    target: "web-react",
    adapterVersion: "tanren.web-react.v1",
    artifactDigest: DIGEST,
    scenarioMatrixDigest: DIGEST,
    requiredCapabilities: [...capabilities],
    resolvedCapabilities: capabilities.map((capability) => ({ capability, supported: true, evidenceDigest: DIGEST })),
    criticalProofs: [{ key: "web-react.build", kind: "build", evidenceDigest: DIGEST, passed: true }],
    positiveCases: [{ key: "web-react.tokens", description: "tokens", evidenceDigest: DIGEST, passed: true }],
    negativeControls: [
      { key: "web-react.tokens-missing", description: "missing", expectFindingCode: "web.missing", passed: true },
    ],
    outcome: "passed",
    notes: "",
  };
}

function conformanceRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const receipt = (overrides.receipt as DesignAdapterConformanceReceiptV1 | undefined) ?? passedReceipt();
  return {
    target: "web-react",
    artifact_digest: DIGEST,
    persisted_artifact_digest: DIGEST,
    receipt_digest: designAdapterConformanceReceiptDigest(receipt),
    receipt,
    outcome: "passed",
    ...overrides,
  };
}

function resolveOverFakeClient(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly capabilities?: readonly string[];
}) {
  const client: Pick<pg.PoolClient, "query"> = {
    async query(sql: string) {
      if (sql.includes("FROM runs WHERE org_id")) return { rows: [{ project_id: PROJECT_ID }] };
      if (sql.includes("WITH head_contract AS")) {
        return { rows: [{ release_id: "release_ds7", contract: requiredTargetContract(input.capabilities) }] };
      }
      if (sql.includes("SELECT DISTINCT ON (run.target)")) return { rows: [...input.rows] };
      throw new Error(`unexpected fake land-gate query: ${sql.slice(0, 80)}`);
    },
  };
  return resolveDesignRenderGate({} as pg.Pool, ORG_ID, "run_ds7", async (_orgId, operation) => operation(client));
}

describe("resolveDesignRenderGate — conformance evidence read through a fake query client", () => {
  it.each([
    ["absent", [], undefined, "has no design-adapter conformance receipt"],
    ["failed", [conformanceRow({ outcome: "failed" })], undefined, "recorded 'failed'"],
    [
      "stale",
      [conformanceRow({ persisted_artifact_digest: `sha256:${"c".repeat(64)}` })],
      undefined,
      "receipt artifact digest is stale",
    ],
    ["capability-mismatched", [conformanceRow()], ["catalog"], "capability set does not match"],
  ] as const)(
    "returns inconclusive_infrastructure for %s conformance evidence",
    async (_name, rows, capabilities, reason) => {
      const gate = await resolveOverFakeClient({ rows, capabilities });

      expect(gate).toMatchObject({ kind: "inconclusive_infrastructure" });
      expect(gate.kind === "inconclusive_infrastructure" && gate.reason).toContain(reason);
    },
  );
});
