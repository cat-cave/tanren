// The native gate's verdict PUBLICATION to the forge (the no-Actions delivery model).
// Two invariants are pinned here, both root-caused from a live apex run where a
// fully-PASSING pipeline was halted by an HTTP 403 from the verdict publish:
//
//  1. `publishGateVerdict` issues the gate verdict through the best-effort
//     `SafeVisibilityProjection.publishGate` seam (which the GitHub impl renders as a
//     COMMIT STATUS, never a check-run — the Checks API is Apps-only, so a token
//     credential 403s; a status is the universal, branch-protection-sufficient
//     primitive for both). The seam can never reject — a publish failure surfaces as a
//     `ProjectionOutcome`, never a throw.
//  2. `publishGateVerdictBestEffort` treats a publish failure as NON-fatal: a `failed`
//     projection outcome (the captured 403) is reported via the emit seam and the run
//     proceeds to merge on the internal verdict. A FAILED gate is never laundered —
//     only a failed PUBLISH of a verdict is reported; the merge decision lives in the
//     internal `gate.verdict`.
import { describe, expect, it } from "vitest";
import {
  harden,
  type VisibilityProjection,
  type PublishGateInput,
} from "../src/engine/contracts/visibilityProjection.js";
import { publishGateVerdict } from "../src/engine/workflow/gate/publishGateVerdict.js";
import { publishGateVerdictBestEffort } from "../src/engine/workflow/gate/publishGateVerdictBestEffort.js";
import type { GateOutcome } from "../src/engine/workflow/gate/runGateForWhen.js";

const REPO_FULL_NAME = "cat-cave/tanren-fixture";

// A RAW VisibilityProjection that records the publishGate calls (and can be made to
// throw, simulating a forge 403). Hardened into the safe seam the gate functions take.
class RecordingProjection implements VisibilityProjection {
  readonly gates: PublishGateInput[] = [];
  constructor(private readonly failWith?: Error) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async publishGate(input: PublishGateInput): Promise<void> {
    this.gates.push(input);
    if (this.failWith !== undefined) throw this.failWith;
  }
}

const passOutcome: GateOutcome = {
  passed: true,
  results: [{ passed: true, tier: "default", when: "pre_merge", steps: [] }],
};
const failOutcome: GateOutcome = {
  passed: false,
  results: [],
  failure: { passed: false, tier: "default", when: "pre_merge", failedStep: "test", exitCode: 1, steps: [] },
};

describe("publishGateVerdict", () => {
  it("publishes the gate verdict through the projection seam as a `tanren/gate` status", async () => {
    const raw = new RecordingProjection();
    const outcome = await publishGateVerdict({
      visibility: harden(raw),
      repoFullName: REPO_FULL_NAME,
      headSha: "abc123",
      outcome: passOutcome,
    });
    expect(outcome.kind).toBe("projected");
    expect(raw.gates).toHaveLength(1);
    const gate = raw.gates[0]!;
    expect(gate).toMatchObject({ repoFullName: REPO_FULL_NAME, headSha: "abc123", verdict: "passed" });
    expect(gate.summary).toContain("passed");
  });

  it("maps a failed gate to a `failed` verdict naming the failing tier + step", async () => {
    const raw = new RecordingProjection();
    await publishGateVerdict({
      visibility: harden(raw),
      repoFullName: REPO_FULL_NAME,
      headSha: "def456",
      outcome: failOutcome,
    });
    const gate = raw.gates[0]!;
    expect(gate.verdict).toBe("failed");
    expect(gate.summary).toContain("default");
    expect(gate.summary).toContain("test");
  });

  it("bounds the summary to GitHub's 140-char commit-status limit", async () => {
    const raw = new RecordingProjection();
    const longTiers = Array.from({ length: 30 }, (_, i) => ({
      passed: true as const,
      tier: `tier-${i}`,
      when: "pre_merge" as const,
      steps: [],
    }));
    await publishGateVerdict({
      visibility: harden(raw),
      repoFullName: REPO_FULL_NAME,
      headSha: "sha",
      outcome: { passed: true, results: longTiers },
    });
    expect(raw.gates[0]!.summary.length).toBeLessThanOrEqual(140);
  });

  it("on a host with NO publishGate, resolves `skipped` (never throws)", async () => {
    const outcome = await publishGateVerdict({
      visibility: harden({}),
      repoFullName: REPO_FULL_NAME,
      headSha: "abc123",
      outcome: passOutcome,
    });
    expect(outcome.kind).toBe("skipped");
  });
});

describe("publishGateVerdictBestEffort", () => {
  it("on a publish 403, the projection captures it (does not propagate) and reports via emit — the run proceeds", async () => {
    const raw = new RecordingProjection(new Error("GitHub status publish failed: HTTP 403"));
    const emitted: Array<{ when: string; headSha: string; passed: boolean; reason: string }> = [];
    // A passing verdict whose forge publish 403s MUST resolve normally (no throw).
    await expect(
      publishGateVerdictBestEffort(
        { visibility: harden(raw), repoFullName: REPO_FULL_NAME, headSha: "abc123", outcome: passOutcome },
        "pre_merge",
        true,
        async (e) => {
          emitted.push(e);
        },
      ),
    ).resolves.toBeUndefined();
    // The failure is observable: one warning carrying the (non-secret) reason + the verdict.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ when: "pre_merge", headSha: "abc123", passed: true });
    expect(emitted[0]!.reason).toContain("403");
  });

  it("on a host with NO publishGate (skipped), reports the skip via emit and resolves", async () => {
    const emitted: Array<{ reason: string }> = [];
    await publishGateVerdictBestEffort(
      { visibility: harden({}), repoFullName: REPO_FULL_NAME, headSha: "abc123", outcome: passOutcome },
      "pre_merge",
      true,
      async (e) => {
        emitted.push(e);
      },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.reason).toContain("skipped");
  });

  it("on a successful publish, emits nothing", async () => {
    const raw = new RecordingProjection();
    const emitted: unknown[] = [];
    await publishGateVerdictBestEffort(
      { visibility: harden(raw), repoFullName: REPO_FULL_NAME, headSha: "abc123", outcome: passOutcome },
      "pre_merge",
      true,
      async (e) => {
        emitted.push(e);
      },
    );
    expect(emitted).toHaveLength(0);
    expect(raw.gates).toHaveLength(1);
  });
});
