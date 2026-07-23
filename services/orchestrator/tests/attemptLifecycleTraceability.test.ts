/**
 * rv-10 DB-free unit cover for the verdict→attempt traceability fail-closed guards and the
 * outcome→classification mapping. The live paths are also exercised by the RLS integration suites,
 * but those are DB-gated and skipped by the coverage run; these tests drive the SAME pure functions
 * directly through a fake org-scoped {@link QueryClient} so every fail-closed arm is asserted as a
 * real typed error, not as incidental line execution.
 */

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { BehaviorVerdictOutcome } from "../src/engine/contracts/runtimeVerificationAdapters.js";
import {
  AttemptlessVerdictHasAttemptsError,
  OrphanVerdictError,
  VerdictAttemptCountMismatchError,
  VerdictAttemptTraceabilityError,
  assertVerdictTraceable,
  classifyAttemptOutcome,
  normalizeAttemptForCi,
  type VerdictAttemptTrace,
  type VerdictTraceabilityInput,
} from "../src/engine/verification/acceptance/index.js";

type QueryClient = Pick<pg.PoolClient, "query">;

interface ProducingAttemptRow {
  readonly behavior_revision_id: string;
  readonly example_hash: string;
  readonly matrix_hash: string;
}

/**
 * Minimal fake honoring exactly the two statements {@link assertVerdictTraceable} runs: the natural-key
 * COUNT and the producing-attempt SELECT. `count` answers the COUNT; `producing` (or its absence) answers
 * the SELECT — so a test can independently model "row present but count disagrees", "row absent", etc.
 */
function fakeClient(config: { readonly count: number; readonly producing?: ProducingAttemptRow }): QueryClient {
  return {
    query: (text: string): Promise<{ rows: readonly unknown[]; rowCount: number }> => {
      if (text.includes("COUNT(*)::int AS n")) {
        return Promise.resolve({ rows: [{ n: config.count }], rowCount: 1 });
      }
      if (text.includes("SELECT behavior_revision_id, example_hash, matrix_hash")) {
        const rows = config.producing === undefined ? [] : [config.producing];
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      throw new Error(`unexpected query: ${text}`);
    },
  } as QueryClient;
}

const BASE: Omit<VerdictTraceabilityInput, "trace" | "attemptCount"> = {
  orgId: "org_1",
  runId: "run_1",
  behaviorRevisionId: "beh_1",
  exampleHash: "ex_1",
  matrixHash: "mx_1",
};

function input(trace: VerdictAttemptTrace, attemptCount: number): VerdictTraceabilityInput {
  return { ...BASE, trace, attemptCount };
}

const ATTEMPTED: VerdictAttemptTrace = { kind: "attempted", producingAttemptId: "att_1" };

describe("assertVerdictTraceable — attemptless escape hatch", () => {
  it("passes when ZERO real attempt rows back the natural key", async () => {
    await expect(
      assertVerdictTraceable(fakeClient({ count: 0 }), input({ kind: "attemptless" }, 0)),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the run actually attempted the behavior (real rows exist)", async () => {
    await expect(
      assertVerdictTraceable(fakeClient({ count: 2 }), input({ kind: "attemptless" }, 0)),
    ).rejects.toBeInstanceOf(AttemptlessVerdictHasAttemptsError);
  });
});

describe("assertVerdictTraceable — attempted production path", () => {
  it("passes when the producing attempt exists, matches the natural key, and the count agrees", async () => {
    const client = fakeClient({
      count: 1,
      producing: { behavior_revision_id: "beh_1", example_hash: "ex_1", matrix_hash: "mx_1" },
    });
    await expect(assertVerdictTraceable(client, input(ATTEMPTED, 1))).resolves.toBeUndefined();
  });

  it("throws OrphanVerdictError when the named producing attempt has no real row", async () => {
    // No producing row at all — the verdict names an attempt that does not exist under (org, run).
    await expect(assertVerdictTraceable(fakeClient({ count: 0 }), input(ATTEMPTED, 1))).rejects.toBeInstanceOf(
      OrphanVerdictError,
    );
  });

  it("throws VerdictAttemptTraceabilityError when the attempt belongs to a DIFFERENT behavior", async () => {
    const client = fakeClient({
      count: 1,
      producing: { behavior_revision_id: "beh_OTHER", example_hash: "ex_1", matrix_hash: "mx_1" },
    });
    await expect(assertVerdictTraceable(client, input(ATTEMPTED, 1))).rejects.toThrow(
      /attempt behavior beh_OTHER != verdict behavior beh_1/u,
    );
  });

  it("throws VerdictAttemptTraceabilityError when the example/matrix key differs", async () => {
    const client = fakeClient({
      count: 1,
      producing: { behavior_revision_id: "beh_1", example_hash: "ex_WRONG", matrix_hash: "mx_1" },
    });
    await expect(assertVerdictTraceable(client, input(ATTEMPTED, 1))).rejects.toBeInstanceOf(
      VerdictAttemptTraceabilityError,
    );
  });

  it("throws OrphanVerdictError when the producing row matches but ZERO natural-key rows are counted", async () => {
    // The named attempt row resolves, yet the natural-key COUNT is 0 — a fabricated pointer with no
    // backing attempt rows for (behavior, example, matrix). Fails closed on the actual===0 arm.
    const client = fakeClient({
      count: 0,
      producing: { behavior_revision_id: "beh_1", example_hash: "ex_1", matrix_hash: "mx_1" },
    });
    await expect(assertVerdictTraceable(client, input(ATTEMPTED, 1))).rejects.toBeInstanceOf(OrphanVerdictError);
  });

  it("throws VerdictAttemptCountMismatchError when real rows disagree with the verdict attempt_count", async () => {
    // Producing row matches and rows exist, but the verdict claims attempt_count=1 while 3 rows back it.
    const client = fakeClient({
      count: 3,
      producing: { behavior_revision_id: "beh_1", example_hash: "ex_1", matrix_hash: "mx_1" },
    });
    await expect(assertVerdictTraceable(client, input(ATTEMPTED, 1))).rejects.toBeInstanceOf(
      VerdictAttemptCountMismatchError,
    );
  });
});

describe("classifyAttemptOutcome — outcome→classification mapping", () => {
  const cases: readonly (readonly [BehaviorVerdictOutcome, string])[] = [
    ["passed", "product_resolved"],
    ["failed_product", "product_failure"],
    ["failed_visual", "product_failure"],
    ["failed_verification_contract", "stale_contract"],
    ["inconclusive_infrastructure", "infra_failure"],
    ["inconclusive_external", "inconclusive"],
    ["cancelled_superseded", "inconclusive"],
  ];
  for (const [outcome, classification] of cases) {
    it(`maps ${outcome} → ${classification}`, () => {
      expect(classifyAttemptOutcome(outcome)).toBe(classification);
    });
  }

  it("throws TypeError on an unknown outcome (exhaustiveness guard)", () => {
    expect(() => classifyAttemptOutcome("bogus" as BehaviorVerdictOutcome)).toThrow(TypeError);
  });
});

describe("normalizeAttemptForCi — exhaustive compatibility mapping", () => {
  const cases: readonly (readonly [BehaviorVerdictOutcome, string])[] = [
    ["passed", "passed"],
    ["failed_product", "failed"],
    ["failed_visual", "failed"],
    ["failed_verification_contract", "failed"],
    ["inconclusive_infrastructure", "error"],
    ["inconclusive_external", "error"],
    ["cancelled_superseded", "skipped"],
  ];
  for (const [outcome, normalized] of cases) {
    it(`maps ${outcome} → ${normalized}`, () => {
      expect(normalizeAttemptForCi(outcome)).toBe(normalized);
    });
  }

  it("throws TypeError on an unknown outcome", () => {
    expect(() => normalizeAttemptForCi("bogus" as BehaviorVerdictOutcome)).toThrow(TypeError);
  });
});
