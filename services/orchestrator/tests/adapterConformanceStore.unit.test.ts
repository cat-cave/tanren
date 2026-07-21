// ds-7 — DB-free proof that the conformance store cannot persist a doctored
// self-passing receipt. The fake pool covers only the artifact coordinate and
// the INSERT payload; no Postgres/RLS test is needed for this fail-closed arm.

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  DesignAdapterConformanceStore,
  type RecordDesignAdapterConformanceRunInput,
} from "../src/engine/design/system/adapterConformanceStore.js";
import type { DesignAdapterConformanceReceiptV1 } from "../src/engine/design/system/adapterConformanceReceipt.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function passedReceipt(): DesignAdapterConformanceReceiptV1 {
  return {
    version: 1,
    schemaVersion: "design_adapter_conformance.v1",
    target: "web-react",
    adapterVersion: "tanren.web-react.v1",
    artifactDigest: DIGEST,
    scenarioMatrixDigest: DIGEST,
    requiredCapabilities: ["tokens"],
    resolvedCapabilities: [{ capability: "tokens", supported: true, evidenceDigest: DIGEST }],
    criticalProofs: [{ key: "web-react.build", kind: "build", evidenceDigest: DIGEST, passed: true }],
    positiveCases: [{ key: "web-react.tokens", description: "tokens", evidenceDigest: DIGEST, passed: true }],
    negativeControls: [
      { key: "web-react.tokens-missing", description: "missing", expectFindingCode: "web.missing", passed: true },
    ],
    outcome: "passed",
    notes: "all checks claimed green",
  };
}

function recordingPool() {
  const queries: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
  const query = vi.fn<(sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(
    async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT digest FROM design_artifacts")) return { rows: [{ digest: DIGEST }] };
      return { rows: [] };
    },
  );
  const pool = {
    connect: async () => ({ query, release() {} }),
  } as unknown as pg.Pool;
  return { pool, queries };
}

function artifactReadPool(rows: readonly { readonly digest: string }[]): pg.Pool {
  const query = async (sql: string): Promise<{ rows: readonly { readonly digest: string }[] }> => {
    if (sql.includes("SELECT digest FROM design_artifacts")) return { rows };
    return { rows: [] };
  };
  return { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
}

function readPool(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn<(sql: string) => Promise<{ rows: unknown[] }>>(async (sql: string) => {
    if (sql.includes("FROM design_adapter_conformance_runs")) return { rows: [...rows] };
    return { rows: [] };
  });
  return { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
}

function storedRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    org_id: "org_ds7",
    project_id: "project_ds7",
    id: "conformance_ds7",
    release_id: "release_ds7",
    artifact_id: "artifact_ds7",
    target: "web-react",
    adapter_version: "tanren.web-react.v1",
    artifact_digest: DIGEST,
    receipt_digest: DIGEST,
    receipt: passedReceipt(),
    outcome: "passed",
    notes: "green",
    created_at: new Date("2026-07-21T00:00:00.000Z"),
    ...overrides,
  };
}

describe("DesignAdapterConformanceStore — DB-free durable fail-closed receipt handling", () => {
  it("rewrites BOTH row outcome and frozen body outcome to failed for a doctored passed receipt", async () => {
    const { pool, queries } = recordingPool();
    const store = new DesignAdapterConformanceStore(pool);
    const doctored: DesignAdapterConformanceReceiptV1 = {
      ...passedReceipt(),
      criticalProofs: [{ key: "web-react.build", kind: "build", evidenceDigest: DIGEST, passed: false }],
    };
    const input: RecordDesignAdapterConformanceRunInput = {
      orgId: "org_ds7",
      projectId: "project_ds7",
      id: "conformance_ds7_doctored",
      releaseId: "release_ds7",
      artifactId: "artifact_ds7",
      target: "web-react",
      adapterVersion: "tanren.web-react.v1",
      artifactDigest: DIGEST,
      receipt: doctored,
    };

    const recorded = await store.record(input);

    expect(recorded.outcome).toBe("failed");
    expect(recorded.receipt?.outcome).toBe("failed");
    const insert = queries.find(({ sql }) => sql.includes("INSERT INTO design_adapter_conformance_runs"));
    expect(insert).toBeDefined();
    expect(insert?.params[10]).toBe("failed");
    expect(JSON.parse(String(insert?.params[9]))).toMatchObject({ outcome: "failed" });
  });

  it("maps latest, list, and id reads from frozen receipt rows through the scoped fake pool", async () => {
    const store = new DesignAdapterConformanceStore(readPool([storedRow()]));

    await expect(store.readLatest("org_ds7", "project_ds7", "web-react")).resolves.toMatchObject({
      id: "conformance_ds7",
      receipt: expect.objectContaining({ outcome: "passed" }),
    });
    await expect(store.listForProject("org_ds7", "project_ds7")).resolves.toHaveLength(1);
    await expect(store.readById("org_ds7", "conformance_ds7")).resolves.toMatchObject({ target: "web-react" });
  });

  it("rejects an unknown persisted outcome rather than treating it as a pass", async () => {
    const store = new DesignAdapterConformanceStore(readPool([storedRow({ outcome: "forged-green" })]));

    await expect(store.readById("org_ds7", "conformance_ds7")).rejects.toThrow(/frozen enum/u);
  });

  it("rejects an unreadable frozen receipt rather than returning a partial row", async () => {
    const store = new DesignAdapterConformanceStore(readPool([storedRow({ receipt: { forged: true } })]));

    await expect(store.readLatest("org_ds7", "project_ds7", "web-react")).rejects.toThrow(/is corrupt/u);
  });

  it("rejects a receipt whose target does not match the target coordinate before it is written", async () => {
    const store = new DesignAdapterConformanceStore(artifactReadPool([{ digest: DIGEST }]));

    await expect(
      store.record({
        orgId: "org_ds7",
        projectId: "project_ds7",
        id: "conformance_wrong_target",
        releaseId: "release_ds7",
        artifactId: "artifact_ds7",
        target: "web-react",
        adapterVersion: "tanren.web-react.v1",
        artifactDigest: DIGEST,
        receipt: { ...passedReceipt(), target: "flutter" },
      }),
    ).rejects.toThrow(/does not match run target/u);
  });

  it("rejects absent and digest-mismatched artifact rows instead of persisting a detached receipt", async () => {
    const input: RecordDesignAdapterConformanceRunInput = {
      orgId: "org_ds7",
      projectId: "project_ds7",
      id: "conformance_artifact_coordinate",
      releaseId: "release_ds7",
      artifactId: "artifact_ds7",
      target: "web-react",
      adapterVersion: "tanren.web-react.v1",
      artifactDigest: DIGEST,
      receipt: passedReceipt(),
    };

    await expect(new DesignAdapterConformanceStore(artifactReadPool([])).record(input)).rejects.toThrow(/not found/u);
    await expect(
      new DesignAdapterConformanceStore(artifactReadPool([{ digest: `sha256:${"b".repeat(64)}` }])).record(input),
    ).rejects.toThrow(/digest mismatch/u);
  });
});
