// A LOCAL {@link CommandSubstrate} test fixture: runs each command on the REAL
// local machine via `/bin/sh`, with the same cwd/stdin/timeout/in-band-failure
// semantics the SSH substrate gives the engine. This lets the Wave-1 conformance
// drive the REAL `JjWorkspaceVcsCore` against an actual `jj` process in a temp dir —
// the impl is exercised with real VCS plumbing, not a scripted echo. TEST FIXTURE
// ONLY (lives under tests/, never src/): the live path is always the SSH substrate
// against an allocated runner.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerHandle } from "../../../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../../../src/engine/contracts/commandSubstrate.js";
import { stripGitRepoSelectingEnv } from "./fixtureGitEnv.js";

/** A throwaway local handle — the local substrate ignores the runner address. */
export const LOCAL_HANDLE: RunnerHandle = { backend: "ssh" };

export class LocalCommandSubstrate implements CommandSubstrate {
  // A throwaway scratch dir used as the cwd for any command that doesn't set one. The
  // substrate must NEVER fall back to process.cwd(): under vitest that's the HOST repo,
  // and a cwd-less bootstrap (`mkdir -p … && jj git clone --colocate …`, which runs
  // before its own dir exists) would then execute INSIDE the host repo — jj flips it to
  // `core.bare=true` and seeds stray fixture bookmarks, corrupting the checkout. Real
  // ops pass an explicit absolute workspace cwd; this only anchors that one
  // pre-dir-creation command to a safe non-git scratch.
  private readonly safeCwd = mkdtempSync(join(tmpdir(), "tanren-localcmd-"));

  async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    // The child env: the git REPO-SELECTING vars (GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/…) are
    // SCRUBBED so a leaked one can't override the per-command `cwd` and redirect a jj/git op
    // (the `jj git clone --colocate` bootstrap + its colocated git backend) onto the HOST
    // worktree. cwd is then the SOLE repo selector — the same isolation discipline the
    // direct-`execFileSync` fixtures use (fixtureGitEnv.ts). Read from `process.env` per run
    // (not once) so a leak present whenever a command runs is scrubbed. This complements the
    // safeCwd fallback above (which guards the cwd-less bootstrap command).
    const childEnv = stripGitRepoSelectingEnv({ ...process.env, GIT_TERMINAL_PROMPT: "0" });
    return new Promise<CommandResult>((resolve) => {
      const child = spawn("/bin/sh", ["-c", command.command], {
        cwd: command.cwd === undefined || command.cwd === "" ? this.safeCwd : command.cwd,
        env: childEnv,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, command.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      if (command.stdin !== undefined) {
        child.stdin.write(command.stdin);
      }
      child.stdin.end();

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          failure: { kind: "ssh_failed", target: "local", message: err.message },
        });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          stdout,
          stderr,
          signal: signal ?? undefined,
          timedOut,
        });
      });
    });
  }
}
