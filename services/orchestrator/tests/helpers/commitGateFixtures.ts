/**
 * Fixtures shared by the commit-gate suites (`writerCommitGateRecovery.test.ts`,
 * `writerCommitGateBoundaries.test.ts`). Extracted so each suite stays under the 500-line
 * architecture cap while both drive the SAME rejection — the verbatim one from the bench run.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../../src/engine/contracts/commandSubstrate.js";
import { type RunnerHandle, sshRunnerHandle } from "../../src/engine/contracts/allocator.js";

// Built through the SSH constructor rather than annotated `RunnerHandle`. `RunnerHandle`
// declares ONLY `backend` — the reach fields are `SshRunnerHandle`'s — so a bare literal is an
// excess-property error that nothing catches, because this repo does not typecheck its tests
// (`tsconfig` `include` is `src/**/*.ts`). `sshRunnerHandle` is the single place that stamps
// the tag, so the fixture is checked against the real shape.
export const target = sshRunnerHandle({
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
});

export const WORKSPACE = "/workspace/runs/run_gate/repo";
export const BASELINE_SHA = "b".repeat(40);
export const WRITER_DIFF = "diff --git a/x b/x\n";

// The rejection VERBATIM from the bench run, split across the two streams the way the real
// tooling splits it: cspell writes its findings (the actionable part — the files, the lines,
// the unknown word) to STDOUT, and husky writes only its epilogue to STDERR.
export const CSPELL_STDOUT = [
  "backend/tests/unit/events/test_treatmentx_isolation.py:37:36 - Unknown word (TREATMENTX)",
  "backend/tests/unit/events/test_event_enums.py:164:25 - Unknown word (TREATMENTX)",
  "CSpell: Files checked: 4, Issues found: 23 in 4 files.",
].join("\n");
export const HUSKY_STDERR = [
  "Lint-staged failed. Please fix the issues above.",
  "husky - pre-commit script failed (code 1)",
].join("\n");

export function isCommit(command: string): boolean {
  return /git (?:-c [^ ]+ )?commit /u.test(command);
}

/** A substrate whose project pre-commit hook rejects the writer's commit, cspell-style. */
export class HookRejectsSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];

  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (isCommit(command.command)) {
      return { exitCode: 1, stdout: CSPELL_STDOUT, stderr: HUSKY_STDERR, timedOut: false };
    }
    // Staging carries the staged-change probe now (stageWorkspaceChanges): report that there
    // IS a staged delta so the gated commit is reached and the hook gets to vote on it.
    if (command.command.includes("git add -A")) return { ...ok, stdout: "STAGED_CHANGES\n" };
    // No commit landed, so the baseline..HEAD log is empty.
    if (command.command.includes("git log")) return ok;
    if (command.command.includes("git diff --no-color")) return { ...ok, stdout: WRITER_DIFF };
    if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${BASELINE_SHA}\n` };
    return ok;
  }
}

// A `git` shim whose per-subcommand exit codes the test dictates. `git add`/`git diff` are all
// the staging script invokes; everything else is a no-op success.
export const fakeGit = (add: number, diff: number): string =>
  [
    "#!/bin/sh",
    'case "$1" in',
    `  add) echo "fatal: unable to create index.lock: File exists." 1>&2; exit ${add} ;;`,
    `  diff) exit ${diff} ;;`,
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n");

const fakeGitDirs: string[] = [];

/** Remove every temp dir a `RealShellSsh` created. Call from the suite's `afterEach`. */
export function cleanupFakeGitDirs(): void {
  for (const dir of fakeGitDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * A substrate that runs `command.command` through a real `sh`, with a fake `git` — whose per-
 * subcommand exit codes the test dictates — first on PATH, so the staging script's SHELL logic
 * (not a mock) is what is pinned. Pair with `cleanupFakeGitDirs()` in `afterEach`.
 */
export class RealShellSsh implements CommandSubstrate {
  private readonly binDir: string;
  constructor(fakeGitScript: string) {
    this.binDir = mkdtempSync(join(tmpdir(), "commit-gate-fake-git-"));
    fakeGitDirs.push(this.binDir);
    const gitPath = join(this.binDir, "git");
    writeFileSync(gitPath, fakeGitScript, { mode: 0o755 });
    chmodSync(gitPath, 0o755);
  }
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    const proc = spawnSync("sh", ["-c", command.command], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${this.binDir}:${process.env.PATH ?? ""}` },
    });
    return { exitCode: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
  }
}
