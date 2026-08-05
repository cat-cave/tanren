// THE PROJECT'S COMMIT GATE IS FEEDBACK, NOT A RUN-KILLER.
//
// The writer adapters edit the workspace in place and Tanren commits afterwards, with the
// repository's hook path deliberately LIVE (#1407/#1408) so the project's own pre-commit
// gate votes on Tanren's output. Before this change a NO vote was fatal:
// `runWorkspaceSshCommand` throws on a nonzero exit, NOTHING on the writer path catches it,
// the stage finalize guard mislabels it `crashed` and re-throws, and the run dies as
// `run.failed { failureCode: "workspace" }` — discarding every already-passed subtask and
// all convergence state, and skipping run-end accounting. The writer, the one agent that
// could have fixed it, had already exited and never learned anything was wrong.
//
// Observed live on a real-monorepo bench run against a hard spec: the writer authored a real
// test file, cspell rejected the commit over ONE new domain term, and the run halted. The
// human who solved the same spec hit the identical gate and fixed it with a two-line
// dictionary edit. Everything needed to fix it was in the error text.
//
// A commit rejected by the project's own quality gate is the MOST actionable failure a
// writer can receive — deterministic, local, reproducible, self-describing. So it is now
// classified (`exitReason: "commit_rejected"`) and routed through the SAME feedback path a
// failed gate tier uses: re-drive the writer with the hook's own output as steering, under
// the SAME convergence budget, converging to the usual loud P0 fixed point if it cannot be
// satisfied. No new retry budget, no commit retry, no weakening of the hook.
import { describe, expect, it } from "vitest";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommitRejection, WriterAdapter, WriterResult } from "../src/engine/providers/types.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import { captureGitStateAfterWriter } from "../src/engine/providers/writerGit.js";
import {
  COMMIT_REJECTION_OUTPUT_LIMIT,
  classifyCommitRejection,
  commitRejectionOutput,
  writerExitReasonFor,
} from "../src/engine/providers/writerCommitGate.js";
import { commitRejectionReason } from "../src/engine/workflow/commitGateSteering.js";
import { WorkspaceCommandError } from "../src/engine/workspace/index.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  convergenceStalled,
  defaultLoopInput,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makePlanner,
  makeTriage,
  triageAllTasks,
} from "./helpers/plannerLoopHelpers.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const WORKSPACE = "/workspace/runs/run_gate/repo";
const BASELINE_SHA = "b".repeat(40);
const WRITER_DIFF = "diff --git a/x b/x\n";

// The rejection VERBATIM from the bench run, split across the two streams the way the real
// tooling splits it: cspell writes its findings (the actionable part — the files, the lines,
// the unknown word) to STDOUT, and husky writes only its epilogue to STDERR.
const CSPELL_STDOUT = [
  "backend/tests/unit/events/test_treatmentx_isolation.py:37:36 - Unknown word (TREATMENTX)",
  "backend/tests/unit/events/test_event_enums.py:164:25 - Unknown word (TREATMENTX)",
  "CSpell: Files checked: 4, Issues found: 23 in 4 files.",
].join("\n");
const HUSKY_STDERR = [
  "Lint-staged failed. Please fix the issues above.",
  "husky - pre-commit script failed (code 1)",
].join("\n");

function isCommit(command: string): boolean {
  return /git (?:-c [^ ]+ )?commit /u.test(command);
}

/**
 * A scripted writer that can report a commit the project's hook rejected. Local to this
 * file rather than added to `makeScriptedWriter`: that shared helper sits exactly at the
 * 500-line architecture cap, and this fixture is only meaningful for the commit-gate path.
 *
 * A rejected commit lands NO commit — `git add -A` succeeded and only `git commit` was
 * refused — but the work stays in the tree, so the diff is non-empty while `commits` is
 * empty. The loop keys its convergence work signature off that diff.
 */
function makeCommitGateWriter(
  script: ReadonlyArray<{ diff: string; exitReason: WriterResult["exitReason"]; rejection?: CommitRejection }>,
): WriterAdapter & { calls: Array<{ prompt: string }> } {
  let index = 0;
  const calls: Array<{ prompt: string }> = [];
  return {
    kind: "writer",
    cli: "fake",
    authRef: "managed:codex:default",
    calls,
    async runWriter(opts): Promise<WriterResult> {
      calls.push({ prompt: opts.prompt });
      const entry = script[index] ?? script.at(-1) ?? { diff: "", exitReason: "completed" as const };
      index += 1;
      return {
        diff: entry.diff,
        commits:
          entry.diff === "" || entry.exitReason === "commit_rejected"
            ? []
            : [{ sha: `sha_${index}`, message: `subtask ${index}` }],
        exitReason: entry.exitReason,
        ...(entry.rejection === undefined ? {} : { commitRejection: entry.rejection }),
        telemetry: { rawEventCount: 1 },
      };
    },
  };
}

/** A substrate whose project pre-commit hook rejects the writer's commit, cspell-style. */
class HookRejectsSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];

  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (isCommit(command.command)) {
      return { exitCode: 1, stdout: CSPELL_STDOUT, stderr: HUSKY_STDERR, timedOut: false };
    }
    // No commit landed, so the baseline..HEAD log is empty.
    if (command.command.includes("git log")) return ok;
    if (command.command.includes("git diff --no-color")) return { ...ok, stdout: WRITER_DIFF };
    if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${BASELINE_SHA}\n` };
    return ok;
  }
}

describe("the project's commit gate reaches the writer instead of killing the run", () => {
  it("codexGit: a rejected commit comes back as a VALUE carrying the hook output, not a throw", async () => {
    const ssh = new HookRejectsSsh();

    const state = await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);

    expect(state.commitRejection).toBeDefined();
    expect(state.commitRejection?.label).toBe("commit codex workspace changes");
    expect(state.commitRejection?.exitCode).toBe(1);
    // No commit landed, but the WORK SURVIVED in the tree — the diff is what the loop
    // uses as the convergence work signature, so losing it would blind the detector.
    expect(state.commits).toEqual([]);
    expect(state.diff).toBe(WRITER_DIFF);
  });

  it("writerGit: the shared CLI-adapter path behaves identically", async () => {
    const ssh = new HookRejectsSsh();

    const state = await captureGitStateAfterWriter(ssh, target, WORKSPACE, BASELINE_SHA, "claude writer");

    expect(state.commitRejection?.label).toBe("commit writer workspace changes");
    expect(state.commits).toEqual([]);
    expect(state.diff).toBe(WRITER_DIFF);
  });

  it("captures BOTH streams — the actionable findings are on stdout, not stderr", async () => {
    // The sharpest content bug available here. The thrown error's message carries a
    // stderr tail ONLY; had the rejection reused it, the writer would receive
    // "Lint-staged failed. Please fix the issues above." and NOT the lines naming the
    // files, the line numbers and the unknown word — i.e. everything needed to fix it.
    const ssh = new HookRejectsSsh();

    const state = await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);
    const output = state.commitRejection?.output ?? "";

    expect(output).toContain("Unknown word (TREATMENTX)");
    expect(output).toContain("test_treatmentx_isolation.py:37:36");
    expect(output).toContain("husky - pre-commit script failed");
  });

  it("bounds the hook output it carries, keeping the TAIL", () => {
    // Rides in a writer prompt; a pathological hook must not balloon it. The tail is
    // kept because tooling prints its summary and verdict last.
    const huge = `${"x".repeat(50_000)}\nFINAL VERDICT LINE`;
    const output = commitRejectionOutput({ exitCode: 1, stdout: huge, stderr: "" });

    expect(output.length).toBeLessThanOrEqual(COMMIT_REJECTION_OUTPUT_LIMIT);
    expect(output).toContain("FINAL VERDICT LINE");
  });

  it("keeps output that is EXACTLY at the limit whole", () => {
    // The boundary itself: `<=` must not be `<`. One char over is truncated to exactly
    // the limit and loses its head; exactly at the limit is passed through untouched.
    const exact = "y".repeat(COMMIT_REJECTION_OUTPUT_LIMIT);
    expect(commitRejectionOutput({ exitCode: 1, stdout: exact, stderr: "" })).toBe(exact);

    const oneOver = `Z${"y".repeat(COMMIT_REJECTION_OUTPUT_LIMIT)}`;
    const truncated = commitRejectionOutput({ exitCode: 1, stdout: oneOver, stderr: "" });
    expect(truncated).toHaveLength(COMMIT_REJECTION_OUTPUT_LIMIT);
    expect(truncated.startsWith("Z")).toBe(false);
  });

  it("joins the two streams exactly, dropping an empty one rather than leaving a blank line", () => {
    // Exact equality, not `toContain`: a stray separator when one stream is empty would
    // put a leading/trailing blank line in front of the writer's only view of the failure.
    expect(commitRejectionOutput({ exitCode: 1, stdout: "findings", stderr: "epilogue" })).toBe("findings\nepilogue");
    expect(commitRejectionOutput({ exitCode: 1, stdout: "", stderr: "epilogue" })).toBe("epilogue");
    expect(commitRejectionOutput({ exitCode: 1, stdout: "findings", stderr: "   \n  " })).toBe("findings");
    expect(commitRejectionOutput({ exitCode: 1, stdout: "", stderr: "" })).toBe("");
  });
});

// THE SHARP EDGE of the whole change. `runWorkspaceSshCommand` throws for three different
// reasons and only ONE of them is the project rendering a judgment. A substrate fault or a
// watchdog stall means the hook never ran at all; re-telling either as "your work is bad"
// would send the writer chasing a defect that is not in its diff, burning iterations
// against a condition it cannot fix.
const result = (over: Partial<CommandResult>): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: "",
  ...over,
});

describe("only a HOOK VERDICT is recoverable — infrastructure faults stay fatal", () => {
  it("a plain nonzero exit IS the hook's verdict", () => {
    const rejection = classifyCommitRejection(
      new WorkspaceCommandError("boom", "commit codex workspace changes", result({ stdout: CSPELL_STDOUT })),
    );

    expect(rejection?.exitCode).toBe(1);
    expect(rejection?.output).toContain("TREATMENTX");
  });

  it("a SUBSTRATE FAILURE is not a verdict — it must keep propagating", () => {
    const rejection = classifyCommitRejection(
      new WorkspaceCommandError("boom", "commit codex workspace changes", result({ failure: { reason: "ssh_error" } })),
    );

    expect(rejection).toBeUndefined();
  });

  it("a WATCHDOG STALL is not a verdict — it must keep propagating", () => {
    const rejection = classifyCommitRejection(
      new WorkspaceCommandError("boom", "commit codex workspace changes", result({ stalled: true })),
    );

    expect(rejection).toBeUndefined();
  });

  it("a non-WorkspaceCommandError throw is never reinterpreted", () => {
    expect(classifyCommitRejection(new Error("something else"))).toBeUndefined();
  });

  it("a zero or absent exit code is not a verdict either", () => {
    // Defense in depth. `runWorkspaceSshCommand` cannot produce these once the failure
    // and stalled arms are excluded, so reaching here means the error did not come from
    // the hook — and inventing a rejection from it would fabricate a verdict the project
    // never rendered, then steer the writer with an empty complaint.
    const label = "commit codex workspace changes";
    expect(classifyCommitRejection(new WorkspaceCommandError("x", label, result({ exitCode: 0 })))).toBeUndefined();
    expect(classifyCommitRejection(new WorkspaceCommandError("x", label, result({ exitCode: null })))).toBeUndefined();
  });

  it("classifies the writer's exitReason from the presence of a rejection", () => {
    // The seam all six adapters share (writerExitReasonFor). A writer whose commit landed
    // is `completed`; one whose commit the hook refused is `commit_rejected` — inverting
    // this would either lose the recovery entirely or mark clean work as rejected.
    expect(writerExitReasonFor({})).toBe("completed");
    expect(writerExitReasonFor({ commitRejection: undefined })).toBe("completed");
    expect(writerExitReasonFor({ commitRejection: { label: "l", exitCode: 1, output: "o" } })).toBe("commit_rejected");
  });

  it("captureGitStateAfterCodex still THROWS when the substrate itself failed at the commit", async () => {
    // End-to-end negative control: the recovery path must not have made every failed
    // commit survivable, only the ones the project actually judged.
    class SubstrateFailsSsh implements CommandSubstrate {
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        if (isCommit(command.command)) {
          return { exitCode: null, stdout: "", stderr: "", failure: { reason: "ssh_error" } };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }

    await expect(captureGitStateAfterCodex(new SubstrateFailsSsh(), target, WORKSPACE, BASELINE_SHA)).rejects.toThrow(
      "commit codex workspace changes failed",
    );
  });
});

describe("the steering handed to the writer", () => {
  it("carries the hook's own output so the writer fixes the named violation", () => {
    const reason = commitRejectionReason({
      label: "commit codex workspace changes",
      exitCode: 1,
      output: `${CSPELL_STDOUT}\n${HUSKY_STDERR}`,
    });

    expect(reason).toContain("Unknown word (TREATMENTX)");
    expect(reason).toContain("test_treatmentx_isolation.py:37:36");
  });

  it("forbids evading the gate, and says so in the specific ways a model would try", () => {
    // A pre-commit hook is trivially defeatable. A writer told only "make the commit
    // succeed" may reach for --no-verify or gut the rule — which would hand back a PR
    // whose green gate proves nothing. The directive names the evasions explicitly.
    const reason = commitRejectionReason({ label: "commit codex workspace changes", exitCode: 1, output: "nope" });

    expect(reason).toContain("--no-verify");
    expect(reason).toContain("core.hooksPath");
    expect(reason.toLowerCase()).toContain("never");
  });

  it("names the exit code, and omits the output section when there is nothing to show", () => {
    // Two degenerate shapes that must still produce usable steering rather than a
    // dangling "Commit gate output:" header with nothing under it.
    const withExit = commitRejectionReason({ label: "l", exitCode: 3, output: "" });
    expect(withExit).toContain("(exit 3)");
    expect(withExit).not.toContain("Commit gate output:");

    // A rejection the caller could not supply — the steering must still stand alone.
    const absent: CommitRejection | undefined = undefined;
    const noRejection = commitRejectionReason(absent);
    expect(noRejection).toContain("the project's own pre-commit gate REJECTED your work");
    expect(noRejection).not.toContain("exit");
    expect(noRejection).not.toContain("Commit gate output:");
  });

  it("tells the writer what the gate IS and where to fix it", () => {
    // The instructional half of the directive. Each clause is asserted because each is a
    // separate decision about how the writer should read the failure: what the gate
    // represents, that the hook's own output is the source of truth, and that the repair
    // belongs at the source rather than anywhere the error happens to point.
    const reason = commitRejectionReason({ label: "l", exitCode: 1, output: "nope" });

    expect(reason).toContain("declared quality bar for every commit");
    expect(reason).toContain("whatever it enforces");
    expect(reason).toContain("Read the hook output below");
    expect(reason).toContain("fix them at the source");
    expect(reason).toContain("genuinely correct and new");
    expect(reason).toContain("a new domain term the project's dictionary has not seen");
    expect(reason).toContain("updating the project's OWN declared configuration to register it");
  });

  it("separates header, directive and hook output onto their own lines", () => {
    // The writer reads this inline in its prompt; a collapsed join would run the exit
    // code, the instructions and the hook's file:line list together into one blob.
    const lines = commitRejectionReason({ label: "l", exitCode: 1, output: "one\ntwo" }).split("\n");

    expect(lines[0]).toBe("the project's own pre-commit gate REJECTED your work (exit 1)");
    expect(lines[1]?.startsWith("This is the project's declared quality bar")).toBe(true);
    expect(lines.slice(2)).toEqual(["Commit gate output:", "one", "two"]);
  });

  it("keeps the anti-evasion clauses that make a green gate mean something", () => {
    // These specific sentences are load-bearing: they are what stops the writer from
    // "fixing" the rejection by removing the check that produced it.
    const reason = commitRejectionReason({ label: "l", exitCode: 1, output: "nope" });

    expect(reason).toContain("never remove or disable a hook");
    expect(reason).toContain("never weaken a rule merely to silence");
    expect(reason).toContain("A hook that ran and passed is evidence; a hook that was skipped is not.");
    expect(reason).toContain("Commit gate output:\nnope");
  });

  it("still permits the fix a human maintainer would actually make", () => {
    // The counterweight: the reference human fix for the bench failure was to register
    // the new domain term in the project's own dictionary. The steering must not read as
    // "never touch project configuration", or it forecloses the correct repair.
    const reason = commitRejectionReason({ label: "commit codex workspace changes", exitCode: 1, output: "nope" });

    expect(reason).toMatch(/dictionary|declared configuration/iu);
  });
});

describe("the inner loop RECOVERS — the live bench failure, end to end", () => {
  const plan = buildPlan([{ title: "T1", intent: "add the isolation test", behaviorIds: ["B1"] }]);
  const rejection = {
    label: "commit codex workspace changes",
    exitCode: 1,
    output: `${CSPELL_STDOUT}\n${HUSKY_STDERR}`,
  };

  it("re-drives the writer with the hook output and COMPLETES the spec", async () => {
    // THE REGRESSION. Attempt 1 authors the test file and the project's cspell hook
    // rejects the commit; attempt 2 also registers the new term and the commit lands.
    // Before this change attempt 1 THREW and there was no attempt 2 — the run died.
    const writer = makeCommitGateWriter([
      { diff: WRITER_DIFF, exitReason: "commit_rejected", rejection },
      { diff: `${WRITER_DIFF}+TREATMENTX\n`, exitReason: "completed" },
    ]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([plan]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });

    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    expect(writer.calls.length).toBe(2);
  });

  it("the SECOND prompt contains the hook's own output — the writer is told what to fix", async () => {
    // Recovery is only real if the feedback actually reaches the model. Assert on the
    // prompt text, not merely on the fact that a second call happened.
    const writer = makeCommitGateWriter([
      { diff: WRITER_DIFF, exitReason: "commit_rejected", rejection },
      { diff: `${WRITER_DIFF}+TREATMENTX\n`, exitReason: "completed" },
    ]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([plan]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });

    await runSubtaskLoop(input);

    const second = writer.calls[1]?.prompt ?? "";
    expect(second).toContain("Unknown word (TREATMENTX)");
    expect(second).toContain("test_treatmentx_isolation.py:37:36");
    expect(second).toContain("--no-verify");
    // And the FIRST prompt did not — the steering is a consequence of the rejection.
    expect(writer.calls[0]?.prompt ?? "").not.toContain("TREATMENTX");
  });

  it("a writer that can NEVER satisfy the hook converges LOUDLY — bounded, not infinite", async () => {
    // THE BUDGET GUARANTEE, and the reason this is not a "retry the commit" loop.
    //
    // Recovery reuses the loop's EXISTING bound and adds no new one. Tanren's doctrine is
    // that no loop is capped by a count (config/shared.ts — the v35 removal of
    // `maxWriterIterPerSubtask`): a loop runs while it CONVERGES and stops at an
    // intelligently-detected fixed point. So an identical hook complaint over an identical
    // diff terminates the inner loop as a residual P0, and the spec-level convergence
    // judgment then halts the run — the exact shape a permanently-failing GATE tier
    // produces (cf. bootstrapFailureRouting.test.ts), because it is the same machinery.
    const writer = makeCommitGateWriter([{ diff: WRITER_DIFF, exitReason: "commit_rejected", rejection }]);
    const { input } = defaultLoopInput({
      convergencePolicy: {
        maxConsecutiveStalls: 1,
        demoRunEnabled: false,
        velocityDeferEnabled: false,
        velocityDeferMaxSeverity: "P3",
        velocityDeferAfterStalls: 0,
      },
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([plan]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
        triage: makeTriage([triageAllTasks]),
        // The hook rejects unchanged every round ⇒ the convergence answerer stalls.
        convergence: makeConvergence([convergenceStalled]),
      },
    });

    const outcome = await runSubtaskLoop(input);

    // It HALTED LOUDLY — it neither looped forever nor laundered the rejection into a pass.
    expect(outcome.kind).toBe("convergence_stalled");
    expect(writer.calls.length).toBeGreaterThan(1);
    expect(writer.calls.length).toBeLessThan(20);
  });
});
