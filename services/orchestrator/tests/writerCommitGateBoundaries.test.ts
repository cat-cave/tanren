// WHERE THE COMMIT GATE'S RECOVERY STOPS — the boundaries that keep it honest.
//
// `writerCommitGateRecovery.test.ts` proves a hook NO vote reaches the writer instead of
// killing the run. This file proves the three things that must NOT happen as a result:
//
//   1. Only a HOOK VERDICT is recoverable. `runWorkspaceSshCommand` throws for three
//      different reasons and only one of them is the project rendering a judgment; a
//      substrate fault, a watchdog stall, or a failure of the STAGING step means the hook
//      never ran at all. Re-telling any of those as "your work is bad" would send the writer
//      chasing a defect that is not in its diff, burning iterations against a condition it
//      cannot fix.
//   2. A rejection rides only the arm it describes — never a timeout/crash/window_exhausted.
//   3. Tanren's own hard-coded commit messages are preflighted under live hooks BEFORE any
//      writer runs, so a repo that refuses them halts as configuration, not as writer rework.
import { afterEach, describe, expect, it } from "vitest";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import { captureGitStateAfterWriter } from "../src/engine/providers/writerGit.js";
import {
  classifyCommitRejection,
  stageWorkspaceChanges,
  writerExitReasonFor,
} from "../src/engine/providers/writerCommitGate.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { createPiWriter } from "../src/engine/providers/pi.js";
import { commitBootstrapState } from "../src/engine/workspace/bootstrap.js";
import { WorkspaceCommandError } from "../src/engine/workspace/index.js";
import {
  BASELINE_SHA,
  CSPELL_STDOUT,
  HUSKY_STDERR,
  HookRejectsSsh,
  RealShellSsh,
  WORKSPACE,
  WRITER_DIFF,
  cleanupFakeGitDirs,
  fakeGit,
  isCommit,
  target,
} from "./helpers/commitGateFixtures.js";

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

  it("a STAGING failure is not a verdict — `git add -A` runs as its own command", async () => {
    // #1420 review (CodeRabbit + codex, same defect from two directions). `git add -A` and
    // `git commit` used to share one `set -eu` script, so an index.lock conflict, a
    // permission error or an unreadable path exited nonzero with no `failure` and no
    // `stalled` — indistinguishable from a hook NO vote. The writer was then handed "the
    // project's own pre-commit gate REJECTED your work" for a fault that is not in its diff
    // and could not be fixed by editing files, and the loop burned iterations against it.
    //
    // The fix is structural, not a sentinel exit code (a hook may exit 3 as freely as git):
    // staging is its own command, so only the COMMIT's exit is ever offered to the
    // classifier. This test drives the fault a shared script would have laundered.
    class StagingFailsSsh implements CommandSubstrate {
      readonly commands: RunnerCommand[] = [];
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        this.commands.push(command);
        if (command.command.includes("git add -A")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "fatal: Unable to create '/workspace/.git/index.lock': File exists.",
            timedOut: false,
          };
        }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
    }

    const ssh = new StagingFailsSsh();
    await expect(captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA)).rejects.toThrow(
      "stage codex workspace changes failed",
    );

    // And it never reached the commit: the run stops at the substrate fault rather than
    // committing a partially staged tree and reading the hook's opinion of it.
    expect(ssh.commands.some((c) => isCommit(c.command))).toBe(false);
    // Pre-fix this same substrate returned a `CommitRejection` instead of throwing, because
    // the one combined command carried BOTH steps. Pin the split itself so a future "tidy
    // this back into one script" restores the defect loudly.
    const staging = ssh.commands.filter((c) => c.command.includes("git add -A"));
    expect(staging).toHaveLength(1);
    // Staging also carries the staged-change probe now (see stageWorkspaceChanges) — both are
    // un-gated workspace prep, so bundling them is safe. What is load-bearing is that it never
    // carries the `git commit`: only the commit's exit may be read as the hook's verdict.
    expect(staging[0]?.command).toContain("git add -A");
    expect(staging[0]?.command).not.toContain("git commit");
  });

  it("the writerGit twin splits staging the same way", async () => {
    class StagingFailsSsh implements CommandSubstrate {
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        if (command.command.includes("git add -A")) {
          return { exitCode: 128, stdout: "", stderr: "error: insufficient permission", timedOut: false };
        }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
    }

    await expect(
      captureGitStateAfterWriter(new StagingFailsSsh(), target, WORKSPACE, BASELINE_SHA, "claude writer"),
    ).rejects.toThrow("stage writer workspace changes failed");
  });

  it("the gated commit command carries the commit ALONE — nothing else can be read as the verdict", async () => {
    // The other half of the split, from the success side. Whatever the gated command
    // contains is what `classifyCommitRejection` is allowed to interpret, so the guarantee
    // is a property of that command's TEXT: it must not carry a second fallible step.
    const ssh = new HookRejectsSsh();
    await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);

    const gated = ssh.commands.find((c) => isCommit(c.command));
    expect(gated?.command).not.toContain("git add");
    // The staged-change probe moved OUT of the gated command into staging (#1420 review). A
    // `git diff --cached --quiet --exit-code` fault (exit > 1, e.g. a corrupt/locked index) is
    // NOT a hook NO vote, so it must not ride inside the one command whose exit the classifier
    // reads as the verdict. The gated command is the bare commit ALONE.
    expect(gated?.command).not.toContain("git diff --cached");
    // …and the probe lives in the (un-gated) staging command, whose faults throw as infra.
    const staged = ssh.commands.find((c) => c.command.includes("git add -A"));
    expect(staged?.command).toContain("git diff --cached --quiet --exit-code");
  });

  it("a staged-change PROBE fault throws as infrastructure — it is never read as commit_rejected (#1434 review)", async () => {
    // The probe (`git diff --cached --quiet --exit-code`) exits 1 for "there is a staged
    // delta" but a DIFFERENT nonzero (e.g. 128) for a corrupt/locked/unreadable index. That
    // is a substrate fault, not the hook's verdict. Because the probe now runs INSIDE the
    // un-gated staging command, such a fault exits the staging command nonzero → throws, and
    // never reaches `classifyCommitRejection`. Pre-fix, the probe rode inside the gated
    // command and a 128 would have been laundered into `commit_rejected`.
    class ProbeFaultsSsh implements CommandSubstrate {
      readonly commands: RunnerCommand[] = [];
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        this.commands.push(command);
        // The stage+probe command fails with git's index-error code (> 1), as a real
        // `git diff --cached` fault would.
        if (command.command.includes("git add -A")) {
          return { exitCode: 128, stdout: "", stderr: "fatal: unable to read index", timedOut: false };
        }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
    }

    const ssh = new ProbeFaultsSsh();
    await expect(captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA)).rejects.toThrow(
      "stage codex workspace changes failed",
    );
    // It stopped at the substrate fault: no commit was ever offered to the classifier.
    expect(ssh.commands.some((c) => isCommit(c.command))).toBe(false);
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
        // Staging reports a staged delta so the flow reaches the commit — where the
        // substrate fault (not a hook verdict) is modeled.
        if (command.command.includes("git add -A")) return { exitCode: 0, stdout: "STAGED_CHANGES\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }

    await expect(captureGitStateAfterCodex(new SubstrateFailsSsh(), target, WORKSPACE, BASELINE_SHA)).rejects.toThrow(
      "commit codex workspace changes failed",
    );
  });
});
describe("a rejection rides ONLY the arm it describes", () => {
  // #1420 review. The adapters capture git state — and therefore the rejection — BEFORE
  // they branch on stalled / usage-limit / nonzero-exit, so a writer that stalled mid-edit
  // and left a tree the hook then ALSO refused has both facts at once. `failedResult` used
  // to build its result with `...gitState`, which carried the rejection onto a `timeout`.
  //
  // The type says "set iff `exitReason === "commit_rejected"`", and this is the case where
  // that stops being free. The leak is invisible to the compiler — the wider captured object
  // is structurally assignable to the narrower `Pick<WriterResult, "diff" | "commits">`
  // parameter — so nothing but a test can hold the invariant.
  //
  // It matters beyond tidiness: `commitRejection` is the writer's steering payload and the
  // hook's output is the TARGET repository's source text. A consumer that reads the field
  // rather than the discriminant would render a rejected commit's file list under a
  // "the writer timed out" heading and steer the writer to fix a violation in a diff the
  // stall means it never finished writing.
  class StalledWriterHookRejectsSsh implements CommandSubstrate {
    async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${BASELINE_SHA}\n` };
      if (isCommit(command.command))
        return { exitCode: 1, stdout: CSPELL_STDOUT, stderr: HUSKY_STDERR, timedOut: false };
      if (command.command.includes("git diff --no-color")) return { ...ok, stdout: WRITER_DIFF };
      // Staging (the `set -u … git add -A … probe` script) reports a staged delta so the gated
      // commit is reached — it does NOT start with "git ", so it must be matched explicitly
      // before the stall fallthrough below.
      if (command.command.includes("git add -A")) return { ...ok, stdout: "STAGED_CHANGES\n" };
      if (command.command.startsWith("git ")) return ok;
      // Everything else is the CLI itself, and it went silent — the watchdog's
      // no-sign-of-life stall. (Matched last: the commit message is "pi writer".)
      return { ...ok, stalled: true };
    }
  }

  it("a stalled writer whose commit was ALSO refused reports timeout, and carries no rejection", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/pi/dev", value: "sk-pi-test-key" });
    const writer = createPiWriter({
      secrets,
      ssh: new StalledWriterHookRejectsSsh(),
      target,
      credentialRef: "credential/pi/dev",
      runId: "run_pi_invariant",
    });

    const piResult = await writer.runWriter({ prompt: "make an edit", workspace: WORKSPACE });

    // The stall WINS — a writer killed mid-edit leaves a tree the hook will obviously
    // refuse, so the stall EXPLAINS the rejection rather than the other way round.
    expect(piResult.exitReason).toBe("timeout");
    // …and the rejection does not tag along. Pre-fix this was the full CommitRejection.
    expect(piResult.commitRejection).toBeUndefined();
    expect(Object.hasOwn(piResult, "commitRejection")).toBe(false);
    // The partial work is still reported — that is the timeout arm's own progress signal.
    expect(piResult.diff).toBe(WRITER_DIFF);
  });
});

describe("the staging script runs under a REAL shell — a `git add -A` fault must propagate (#1434 review)", () => {
  // The mocked-substrate cases above short-circuit "any command containing `git add -A`" to a
  // fixed nonzero result, so they never execute the actual shell and cannot see how the script
  // treats `git add`'s own status. The #1434 P1 was exactly there: the script runs under
  // `set -u` (NOT `set -e`, deliberately, so the probe's expected exit-1 doesn't abort it), so a
  // failed `git add -A` was NOT propagated — control fell through to the staged-change probe and
  // the trailing marker `printf` (exit 0) became the command's status, laundering a staging
  // fault (index.lock / permission / unreadable path) into a valid staged/no-staged result. The
  // caller then skips the gated commit or proceeds on a partial/stale index and reports the
  // writer as completed. These cases execute the REAL `stageWorkspaceChanges` script through
  // `/bin/sh` with a fake `git` on PATH (`RealShellSsh`/`fakeGit` in commitGateFixtures.ts), so
  // the shell logic — not a mock — is what is pinned.
  afterEach(cleanupFakeGitDirs);

  it("a failing `git add -A` throws — it is NOT swallowed into a no-staged-changes result", async () => {
    // Staging fails (128). The probe would report "no staged changes" (0) if it ran — pre-fix,
    // that 0 became the command's status and `stageWorkspaceChanges` returned `false` silently.
    const ssh = new RealShellSsh(fakeGit(128, 0));
    await expect(stageWorkspaceChanges(ssh, target, WORKSPACE, "stage writer workspace changes")).rejects.toThrow(
      "stage writer workspace changes failed",
    );
  });

  it("a staged delta is reported true, and a clean tree false — the happy paths still work", async () => {
    // add succeeds (0); diff exits 1 = "there is a staged delta".
    expect(await stageWorkspaceChanges(new RealShellSsh(fakeGit(0, 1)), target, WORKSPACE, "stage")).toBe(true);
    // add succeeds (0); diff exits 0 = "no staged delta".
    expect(await stageWorkspaceChanges(new RealShellSsh(fakeGit(0, 0)), target, WORKSPACE, "stage")).toBe(false);
  });

  it("a probe fault (diff exit > 1) still throws — the other half of the boundary holds", async () => {
    // add succeeds (0); the staged-change probe faults (128, e.g. a corrupt/locked index). The
    // `else exit "$probe"` arm re-exits nonzero so the whole staging command throws as infra.
    const ssh = new RealShellSsh(fakeGit(0, 128));
    await expect(stageWorkspaceChanges(ssh, target, WORKSPACE, "stage")).rejects.toThrow("stage failed");
  });
});

describe("the bootstrap bookkeeping commit and the writer commit are gated OPPOSITELY", () => {
  // Where the `commit-msg` half of the codex finding on #1420 actually lands.
  //
  // The concern: a project running commitlint would refuse Tanren's hard-coded writer
  // message ("codex writer", "claude writer"), the writer would be steered to fix files,
  // and no file edit can ever make a fixed message pass — so the run would burn iterations
  // and stall as writer rework instead of surfacing the problem.
  //
  // That concern is answered by the commit-gate feedback loop itself, NOT by the bootstrap
  // commit. A `commit-msg` rejection on the writer's PR-bound commit comes back as a
  // `CommitRejection` (writerCommitGate.ts) and rides the SAME work-convergence budget a
  // failed gate tier uses: the hook's complaint does not change and the message cannot, so
  // the loop converges to the usual loud P0 fixed point carrying the hook's own text (the
  // recovery suite pins this), rather than steering forever.
  //
  // The bootstrap commit deliberately does the OPPOSITE of the writer commit, per #1407:
  // it is bookkeeping (install artifacts staged with `git add -A`, DROPPED before the push),
  // and the runner ships NO project toolchain, so a hook needing one would throw UNCAUGHT and
  // kill workspace prep. So it runs under `-c core.hooksPath=/dev/null` — the project's hooks
  // get NO vote on Tanren's bookkeeping — whereas the writer's content-bearing commit keeps
  // them live (this suite's other cases). Pin that asymmetry so a future "make them
  // consistent" edit trips loudly in either direction.
  it("the bootstrap commit gives the project's hooks no vote (#1407) — via hooksPath, not --no-verify", async () => {
    const commands: RunnerCommand[] = [];
    const ssh: CommandSubstrate = {
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        commands.push(command);
        return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "", timedOut: false };
      },
    };

    await commitBootstrapState({ ssh, target, workspacePath: WORKSPACE });

    const bootstrap = commands[0]?.command ?? "";
    expect(bootstrap).toContain("tanren: bootstrap");
    // The hooks get no vote via an explicit hooksPath redirect scoped to THIS commit …
    expect(bootstrap).toContain("core.hooksPath=/dev/null");
    // … and NOT via `--no-verify`, which #1407 rejected because it leaves `prepare-commit-msg`
    // live and reads as a blanket bypass.
    expect(bootstrap).not.toContain("--no-verify");
  });
});
