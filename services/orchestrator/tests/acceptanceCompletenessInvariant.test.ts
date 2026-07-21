import { describe, expect, it } from "vitest";
import { PgAcceptanceCompletenessChecker } from "../src/engine/verification/acceptance/completenessInvariant.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const input = { orgId: "org", projectId: "project", releaseInstanceId: "release", promotedArtifactDigest: DIGEST };

function checker(overrides: Partial<Record<number, readonly Record<string, unknown>[]>> = {}) {
  let call = 0;
  const rows: Record<number, readonly Record<string, unknown>[]> = {
    1: [{ behavior_revision_id: "behavior-a" }],
    2: [{ id: "acceptance-run" }],
    3: [{ behavior_revision_id: "behavior-a" }],
    4: [{ behavior_revision_id: "behavior-a", outcome: "passed", executed_assertion_count: 1 }],
    5: [{ count: 1 }],
    6: [{ count: 1 }],
    ...overrides,
  };
  const pool = {
    query: async () => ({ rows: rows[++call] ?? [] }),
  };
  return new PgAcceptanceCompletenessChecker(pool as never, async (_orgId, operation) => operation(pool as never));
}

describe("acceptance completeness invariant", () => {
  it("passes only the exact triple identity with positive compatibility evidence", async () => {
    await expect(checker().check(input)).resolves.toEqual({
      complete: true,
      runId: "acceptance-run",
      requiredBehaviorRevisionCount: 1,
    });
  });

  it("blocks a missing required verdict instead of accepting a subset", async () => {
    await expect(checker({ 4: [] }).check(input)).resolves.toEqual({
      complete: false,
      failure: "verdict_set_mismatch",
    });
  });

  it("blocks a mismatched sealed gate-proof artifact coordinate", async () => {
    await expect(checker({ 5: [{ count: 0 }] }).check(input)).resolves.toEqual({
      complete: false,
      failure: "gate_proof_artifact_mismatch",
    });
  });

  it("blocks a passed required verdict with no executed assertions", async () => {
    await expect(
      checker({ 4: [{ behavior_revision_id: "behavior-a", outcome: "passed", executed_assertion_count: 0 }] }).check(
        input,
      ),
    ).resolves.toEqual({ complete: false, failure: "required_verdict_unexecuted" });
  });
});
