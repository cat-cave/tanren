// apex v35 — THE ONE run-finalize authority (runFinalizeAuthority.ts). Pins the 3-bucket
// invariant: EVERY terminal outcome maps to exactly ONE of RE-DRIVE | GENUINE-HALT |
// CONVERGE. This is the safety net for the redesign — a transient/internal/crash/orphan/
// conflict fault MUST re-drive (never park) while it is making PROGRESS, escalating ONLY at
// an intelligently-detected FIXED POINT (`priorSameFixedPoint >= 1`); ONLY
// budget/credential-misconfig/mis-spec/human-decision genuine-halt; success converges. There
// is NO hardcoded attempt cap — a progressing loop re-drives UNBOUNDED.

import { describe, expect, it } from "vitest";
import { decideRunDisposition } from "../src/engine/workflow/runFinalizeAuthority.js";
import { MissingCredentialError, UnscopedOrgError } from "../src/engine/credentials/resolveCredentials.js";
// Hoisted to static imports (was a per-test `await import(...)`): the cold dynamic load
// under full-suite parallel load could exceed the default per-test timeout — a flake, not
// a real failure. These are pure error classes; a static import is behavior-identical.
import { WorkspaceBootstrapError } from "../src/engine/workspace/index.js";
import { CodexUsageLimitError } from "../src/engine/providers/codex.js";
import { EmptyWriterCommitError } from "../src/engine/workflow/plannerRunCi.js";

// PROGRESS facts (a different/first failure → re-drive, UNBOUNDED) vs a FIXED POINT (the same
// failure recurring with no new work → escalate). NO attempt count.
const PROGRESS = { priorSameFixedPoint: 0 };
const FIXED_POINT = { priorSameFixedPoint: 1 };

describe("decideRunDisposition — RE-DRIVE: every random/transient/internal/crash class re-drives", () => {
  it("an UNRECOGNIZED / generic error RE-DRIVES (the bare internal error that used to strand)", () => {
    const d = decideRunDisposition({ kind: "error", error: new Error("boom") }, PROGRESS);
    expect(d).toMatchObject({ bucket: "re_drive", failure: { code: "internal" } });
  });

  it("a non-Error throw RE-DRIVES (falls to the internal code)", () => {
    expect(decideRunDisposition({ kind: "error", error: "a string blip" }, PROGRESS).bucket).toBe("re_drive");
    expect(decideRunDisposition({ kind: "error", error: null }, PROGRESS).bucket).toBe("re_drive");
  });

  it("a workspace-bootstrap fault (transient deps install) RE-DRIVES, not parks", () => {
    expect(decideRunDisposition({ kind: "error", error: new WorkspaceBootstrapError("deps") }, PROGRESS).bucket).toBe(
      "re_drive",
    );
  });

  it("a usage-limit window-exhausted fault RE-DRIVES (the walker re-attempts after the window)", () => {
    expect(
      decideRunDisposition({ kind: "error", error: new CodexUsageLimitError("primary", "out") }, PROGRESS).bucket,
    ).toBe("re_drive");
  });

  it("EVERY non-pass exit (writer-stall / window / convergence / gate / review) RE-DRIVES — the whack-a-mole park is gone", () => {
    for (const detail of [
      "window_exhausted",
      "convergence_stalled",
      "merge_gate_unsatisfied",
      "review_stalled",
      "halted",
    ] as const) {
      const d = decideRunDisposition({ kind: "non_pass", detail }, PROGRESS);
      expect(d.bucket).toBe("re_drive");
    }
  });

  it("a non-pass exit preserves its distinct run.outcome WHY (window/convergence) for the recovery surface", () => {
    const w = decideRunDisposition({ kind: "non_pass", detail: "window_exhausted" }, PROGRESS);
    const c = decideRunDisposition({ kind: "non_pass", detail: "convergence_stalled" }, PROGRESS);
    expect(w).toMatchObject({ bucket: "re_drive", runOutcome: "window_exhausted" });
    expect(c).toMatchObject({ bucket: "re_drive", runOutcome: "convergence_stalled" });
  });

  it("a benign ancestor-wait RE-DRIVES with NO fault (never counts toward the cap)", () => {
    const d = decideRunDisposition({ kind: "ancestor_wait" }, PROGRESS);
    expect(d).toEqual({
      bucket: "re_drive",
      runOutcome: "halted",
      subReason: "ancestor_not_ready",
      backoffSeconds: 0,
      consecutiveSameFailure: 0,
    });
  });

  it("a merge `conflict`/`blocked`/`handed_off`/non-native `queued`/`failed` all RE-DRIVE (transient holds, never a human-decision)", () => {
    for (const mergeOutcome of ["conflict", "blocked", "handed_off", "queued", "failed"] as const) {
      expect(decideRunDisposition({ kind: "merge", mergeOutcome }, PROGRESS).bucket).toBe("re_drive");
    }
  });

  it("an empty-writer-commit fault (no commits between base and head) RE-DRIVES, never a hard internal strand (v35)", () => {
    const d = decideRunDisposition(
      { kind: "error", error: new EmptyWriterCommitError("tanren/run_1", "main") },
      PROGRESS,
    );
    expect(d).toMatchObject({ bucket: "re_drive", failure: { code: "empty_writer_output" } });
  });
});

describe("decideRunDisposition — GENUINE-HALT: only the four structural classes", () => {
  it("a credential misconfiguration GENUINE-HALTS immediately (never re-driven, even at count 1)", () => {
    const d = decideRunDisposition({ kind: "error", error: new MissingCredentialError("github_token") }, PROGRESS);
    expect(d).toMatchObject({
      bucket: "genuine_halt",
      reason: "misconfiguration",
      message: expect.stringContaining("credential"),
    });
    expect(d.bucket === "genuine_halt" ? d.message : "").toContain("a human must fix");
  });

  it("an unscoped-org credential fault GENUINE-HALTS as a misconfiguration", () => {
    expect(decideRunDisposition({ kind: "error", error: new UnscopedOrgError() }, PROGRESS).bucket).toBe(
      "genuine_halt",
    );
  });

  it("the SAME transient failure at a FIXED POINT GENUINE-HALTS as a persistent_failure (no hot-loop, no count)", () => {
    // PROGRESS (a changing failure / first of its kind) re-drives — UNBOUNDED, however many
    // attempts. Only a FIXED POINT (the prior attempt was structurally identical) escalates.
    const progressing = decideRunDisposition({ kind: "error", error: new Error("boom") }, PROGRESS);
    const atFixedPoint = decideRunDisposition({ kind: "error", error: new Error("boom") }, FIXED_POINT);
    expect(progressing.bucket).toBe("re_drive");
    expect(atFixedPoint).toMatchObject({
      bucket: "genuine_halt",
      reason: "persistent_failure",
      message: expect.stringContaining("FIXED POINT"),
    });
    expect(atFixedPoint.bucket === "genuine_halt" ? atFixedPoint.message : "").toContain("genuinely stuck");
  });

  it("a merge `needs_attention` (a genuine HITL/changes-requested decision) GENUINE-HALTS as a human_decision", () => {
    const d = decideRunDisposition({ kind: "merge", mergeOutcome: "needs_attention" }, PROGRESS);
    expect(d).toMatchObject({ bucket: "genuine_halt", reason: "human_decision" });
  });

  it("an empty-writer-commit fault at a FIXED POINT GENUINE-HALTS as a persistent_failure (no silent stall)", () => {
    const err = new EmptyWriterCommitError("tanren/run_1", "main");
    expect(decideRunDisposition({ kind: "error", error: err }, PROGRESS).bucket).toBe("re_drive");
    const at = decideRunDisposition({ kind: "error", error: err }, FIXED_POINT);
    expect(at).toMatchObject({ bucket: "genuine_halt", reason: "persistent_failure" });
  });
});

describe("decideRunDisposition — CONVERGE: success", () => {
  it("a merge `merged` outcome CONVERGES", () => {
    expect(decideRunDisposition({ kind: "merge", mergeOutcome: "merged" }, PROGRESS).bucket).toBe("converge");
  });
});

describe("the old strand reasons all fold into the unified buckets (no distinct terminal behavior)", () => {
  it("`halted_reexec` (a halted run) → RE-DRIVE", () => {
    expect(decideRunDisposition({ kind: "non_pass", detail: "halted" }, PROGRESS).bucket).toBe("re_drive");
  });
  it("`no_live_run` / `orphaned_marker` (a crashed orphan, an internal fault) → RE-DRIVE under the cap", () => {
    expect(decideRunDisposition({ kind: "error", error: new Error("crash") }, PROGRESS).bucket).toBe("re_drive");
  });
  it("`persistent_failure` is the ONLY transient → needs_attention path, at a FIXED POINT", () => {
    const d = decideRunDisposition({ kind: "error", error: new Error("crash") }, FIXED_POINT);
    expect(d).toMatchObject({ bucket: "genuine_halt", reason: "persistent_failure" });
  });
});

describe("UNBOUNDED while progressing — no hardcoded attempt cap (apex v35)", () => {
  it("a loop making PROGRESS NEVER escalates, no matter how many attempts (far past any old K)", () => {
    // The detector keys ONLY on whether THIS attempt is a fixed point. A progressing loop
    // always reports priorSameFixedPoint=0, so it re-drives FOREVER — there is no count that
    // flips it to a halt. This is the would-escalate-at-old-K-despite-progress case PASSING.
    // The attempt index is irrelevant: progress is progress, unbounded.
    for (const attempt of [0, 1, 2, 3, 4, 5, 10, 50, 999]) {
      const d = decideRunDisposition({ kind: "error", error: new Error(`failure-${attempt}`) }, PROGRESS);
      expect(d.bucket).toBe("re_drive");
    }
  });
});
