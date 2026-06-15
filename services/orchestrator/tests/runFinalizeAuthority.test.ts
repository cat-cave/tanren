// apex v35 — THE ONE run-finalize authority (runFinalizeAuthority.ts). Pins the 3-bucket
// invariant: EVERY terminal outcome maps to exactly ONE of RE-DRIVE | GENUINE-HALT |
// CONVERGE. This is the safety net for the redesign — a transient/internal/crash/orphan/
// conflict fault MUST re-drive (never park), bounded ONLY by the consecutive-same-failure
// counter; ONLY budget/credential-misconfig/mis-spec/human-decision genuine-halt; success
// converges. These assertions FAIL against the pre-redesign scattered per-path park logic.

import { describe, expect, it } from "vitest";
import { decideRunDisposition, DEFAULT_REDRIVE_ESCALATE_AT } from "../src/engine/workflow/runFinalizeAuthority.js";
import { MissingCredentialError, UnscopedOrgError } from "../src/engine/credentials/resolveCredentials.js";

const K = DEFAULT_REDRIVE_ESCALATE_AT;

describe("decideRunDisposition — RE-DRIVE: every random/transient/internal/crash class re-drives", () => {
  it("an UNRECOGNIZED / generic error RE-DRIVES (the bare internal error that used to strand)", () => {
    const d = decideRunDisposition({ kind: "error", error: new Error("boom") }, 1);
    expect(d).toMatchObject({ bucket: "re_drive", failure: { code: "internal" } });
  });

  it("a non-Error throw RE-DRIVES (falls to the internal code)", () => {
    expect(decideRunDisposition({ kind: "error", error: "a string blip" }, 1).bucket).toBe("re_drive");
    expect(decideRunDisposition({ kind: "error", error: null }, 1).bucket).toBe("re_drive");
  });

  it("a workspace-bootstrap fault (transient deps install) RE-DRIVES, not parks", async () => {
    const { WorkspaceBootstrapError } = await import("../src/engine/workspace/index.js");
    expect(decideRunDisposition({ kind: "error", error: new WorkspaceBootstrapError("deps") }, 1).bucket).toBe(
      "re_drive",
    );
  });

  it("a usage-limit window-exhausted fault RE-DRIVES (the walker re-attempts after the window)", async () => {
    const { CodexUsageLimitError } = await import("../src/engine/providers/codex.js");
    expect(decideRunDisposition({ kind: "error", error: new CodexUsageLimitError("primary", "out") }, 1).bucket).toBe(
      "re_drive",
    );
  });

  it("EVERY non-pass exit (writer-stall / window / convergence / gate / review) RE-DRIVES — the whack-a-mole park is gone", () => {
    for (const detail of [
      "window_exhausted",
      "convergence_stalled",
      "merge_gate_unsatisfied",
      "review_stalled",
      "halted",
    ] as const) {
      const d = decideRunDisposition({ kind: "non_pass", detail }, 1);
      expect(d.bucket).toBe("re_drive");
    }
  });

  it("a non-pass exit preserves its distinct run.outcome WHY (window/convergence) for the recovery surface", () => {
    const w = decideRunDisposition({ kind: "non_pass", detail: "window_exhausted" }, 1);
    const c = decideRunDisposition({ kind: "non_pass", detail: "convergence_stalled" }, 1);
    expect(w).toMatchObject({ bucket: "re_drive", runOutcome: "window_exhausted" });
    expect(c).toMatchObject({ bucket: "re_drive", runOutcome: "convergence_stalled" });
  });

  it("a benign ancestor-wait RE-DRIVES with NO fault (never counts toward the cap)", () => {
    const d = decideRunDisposition({ kind: "ancestor_wait" }, 1);
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
      expect(decideRunDisposition({ kind: "merge", mergeOutcome }, 0).bucket).toBe("re_drive");
    }
  });
});

describe("decideRunDisposition — GENUINE-HALT: only the four structural classes", () => {
  it("a credential misconfiguration GENUINE-HALTS immediately (never re-driven, even at count 1)", () => {
    const d = decideRunDisposition({ kind: "error", error: new MissingCredentialError("github_token") }, 1);
    expect(d).toMatchObject({
      bucket: "genuine_halt",
      reason: "misconfiguration",
      message: expect.stringContaining("credential"),
    });
    expect(d.bucket === "genuine_halt" ? d.message : "").toContain("a human must fix");
  });

  it("an unscoped-org credential fault GENUINE-HALTS as a misconfiguration", () => {
    expect(decideRunDisposition({ kind: "error", error: new UnscopedOrgError() }, 1).bucket).toBe("genuine_halt");
  });

  it("the SAME transient failure K times in a row GENUINE-HALTS as a persistent_failure (no hot-loop)", () => {
    const under = decideRunDisposition({ kind: "error", error: new Error("boom") }, K - 1);
    const at = decideRunDisposition({ kind: "error", error: new Error("boom") }, K);
    expect(under.bucket).toBe("re_drive");
    expect(at).toMatchObject({
      bucket: "genuine_halt",
      reason: "persistent_failure",
      message: expect.stringContaining(`${K} times in a row`),
    });
    expect(at.bucket === "genuine_halt" ? at.message : "").toContain("genuinely stuck");
  });

  it("a merge `needs_attention` (a genuine HITL/changes-requested decision) GENUINE-HALTS as a human_decision", () => {
    const d = decideRunDisposition({ kind: "merge", mergeOutcome: "needs_attention" }, 0);
    expect(d).toMatchObject({ bucket: "genuine_halt", reason: "human_decision" });
  });
});

describe("decideRunDisposition — CONVERGE: success", () => {
  it("a merge `merged` outcome CONVERGES", () => {
    expect(decideRunDisposition({ kind: "merge", mergeOutcome: "merged" }, 0).bucket).toBe("converge");
  });
});

describe("the old strand reasons all fold into the unified buckets (no distinct terminal behavior)", () => {
  it("`halted_reexec` (a halted run) → RE-DRIVE", () => {
    expect(decideRunDisposition({ kind: "non_pass", detail: "halted" }, 1).bucket).toBe("re_drive");
  });
  it("`no_live_run` / `orphaned_marker` (a crashed orphan, an internal fault) → RE-DRIVE under the cap", () => {
    expect(decideRunDisposition({ kind: "error", error: new Error("crash") }, 1).bucket).toBe("re_drive");
  });
  it("`persistent_failure` is the ONLY transient → needs_attention path, at the cap K", () => {
    const d = decideRunDisposition({ kind: "error", error: new Error("crash") }, K);
    expect(d).toMatchObject({ bucket: "genuine_halt", reason: "persistent_failure" });
  });
});
