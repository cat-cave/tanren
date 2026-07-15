// Production assembly proof: buildBatchMergeCoordinator wires PgRecoveryEvidencePort
// and a RecoveryParkWriter-capable escalator — settlement does not fail-closed park
// solely because the evidence port was omitted.

import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { Allocator } from "../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { SecretStore } from "../src/engine/contracts/secretStore.js";
import type { RecoveryParkWriter, RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import { buildBatchMergeCoordinator } from "../src/engine/merge/batchCoordinatorBuild.js";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { PgRecoveryEvidencePort } from "../src/engine/merge/recoveryEvidencePg.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

function fakePool(): pg.Pool {
  const query = vi.fn<() => Promise<{ rows: unknown[]; rowCount: number }>>(async () => ({
    rows: [],
    rowCount: 0,
  }));
  return {
    query,
    connect: async () => ({ query, release: () => {} }),
    totalCount: 0,
  } as unknown as pg.Pool;
}

function parkWriter(): RunStateWriter & RecoveryParkWriter {
  const base = new InMemoryRunStateWriter();
  return Object.assign(base, {
    async parkRecoveryAndDequeue() {
      return { kind: "parked" as const, newlyParked: true };
    },
  });
}

describe("buildBatchMergeCoordinator — production evidence wiring", () => {
  it("constructs with PgRecoveryEvidencePort on the batch coordinator deps", () => {
    const pool = fakePool();
    const coordinator = buildBatchMergeCoordinator({
      pool,
      secrets: {} as SecretStore,
      githubHttp: { request: async () => ({ status: 200, body: {} }) } as never,
      allocator: {} as Allocator,
      ssh: {} as CommandSubstrate,
      identitySecretRef: "id",
      runStateWriter: parkWriter(),
    });
    expect(coordinator).toBeInstanceOf(BatchMergeCoordinator);
    // Private deps — assert via structural access that recoveryEvidence is the real port.
    const deps = (coordinator as unknown as { deps: { recoveryEvidence?: unknown } }).deps;
    expect(deps.recoveryEvidence).toBeInstanceOf(PgRecoveryEvidencePort);
  });
});
