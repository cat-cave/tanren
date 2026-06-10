// §3.1 LOCK (docs/audits/2026-06-09-apex-pre-run.md): a CLEAN live base-shift rebase
// advances the head LOCALLY only — it MUST be exported + authed-force-pushed to the forge
// head branch BEFORE the runner is released, so the re-gate verifies the ACTUAL landing
// tree (NEVER-MERGE-UNVERIFIED) and the recorded head exists on the forge. Driven against a
// REAL `jj` process (the LocalCommandSubstrate) + a real git origin: rebase a published head
// onto a shifted base, export, `pushJjHead`, then assert the ORIGIN's head branch now points
// at the rebased head (proving the rebase was PUSHED, not left local-only as the bug did).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JjWorkspaceVcsCore } from "../src/engine/providers/jjWorkspaceVcsCore.js";
import { pushJjHead } from "../src/engine/workflow/reviewMerge/conflictResolver/jjAuthedPush.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./conformance/fakes/localCommandSubstrate.js";
import { assertGitDirUnder, fixtureGitEnv } from "./conformance/fakes/fixtureGitEnv.js";

// The git env every fixture child runs under: the deterministic Fixture author PLUS the git
// repo-selecting vars (GIT_DIR/GIT_WORK_TREE/…) SCRUBBED, so a leaked one can never redirect a
// `cwd`-scoped git op onto the host worktree (the live branch-corruption vector). Read from
// `process.env` at CALL time (not module load) so a leak present whenever the fixture runs is
// scrubbed — not just one captured at import. (jj children are scrubbed by LocalCommandSubstrate.)
function gitEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv(process.env);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
}

/**
 * A real NON-BARE git origin with `main`, a shifted base `main2` (an extra commit on main),
 * and a published head `feat` (off the ORIGINAL main). A non-bare origin is used so the push
 * can land on it; the head branch is checked out off `main` so its rebase onto `main2` is a
 * clean fast-forward-able advance.
 */
function makeShiftFixture(): { originPath: string; featSha: string } {
  const root = mkdtempSync(join(tmpdir(), "tanren-base-shift-"));
  const originPath = join(root, "origin");
  mkdirSync(originPath, { recursive: true });
  git(originPath, ["init", "--quiet", "--initial-branch=main"]);
  // DEFENSIVE GUARD: prove `git init` selected the temp origin dir — not a leaked GIT_DIR /
  // the host worktree's real `.git` — BEFORE any commit can land on the worktree's branch.
  assertGitDirUnder(originPath, root, gitEnv());
  // accept pushes to the checked-out branch's repo by allowing updates to non-current refs only.
  git(originPath, ["config", "receive.denyCurrentBranch", "ignore"]);
  writeFileSync(join(originPath, "base.txt"), "base\n");
  git(originPath, ["add", "-A"]);
  git(originPath, ["commit", "--quiet", "-m", "base"]);

  // feat: a published head off main (edits its own file → clean rebase onto a shifted base).
  git(originPath, ["checkout", "--quiet", "-b", "feat"]);
  writeFileSync(join(originPath, "feat.txt"), "feat\n");
  git(originPath, ["add", "-A"]);
  git(originPath, ["commit", "--quiet", "-m", "feat work"]);
  const featSha = git(originPath, ["rev-parse", "feat"]).trim();

  // main2: the shifted base (an extra commit on main, a DIFFERENT file → no conflict).
  git(originPath, ["checkout", "--quiet", "main"]);
  git(originPath, ["checkout", "--quiet", "-b", "main2"]);
  writeFileSync(join(originPath, "shift.txt"), "shift\n");
  git(originPath, ["add", "-A"]);
  git(originPath, ["commit", "--quiet", "-m", "base advance"]);
  git(originPath, ["checkout", "--quiet", "main"]);
  return { originPath, featSha };
}

describe("§3.1 clean base-shift rebase is PUSHED (real jj)", () => {
  it("export + pushJjHead advances the ORIGIN head branch to the rebased head (not local-only)", async () => {
    const { originPath, featSha } = makeShiftFixture();
    const ssh = new LocalCommandSubstrate();
    const scratch = mkdtempSync(join(tmpdir(), "tanren-base-shift-ws-"));
    const wsPath = join(scratch, "ws");
    const core = new JjWorkspaceVcsCore({ substrate: ssh, target: LOCAL_HANDLE, timeoutMs: 60_000 });

    // Open on main (the cloned default), prep the published `feat` head for rewrite (the
    // SAME track + immutable-heads prep the live opener does), rebase feat onto the SHIFTED
    // base `main2@origin`, export. (The working-copy base for `jj new` is just where edits
    // sit; the rebase TARGET is the shifted base, exactly as the live path threads it.)
    const ws = await core.openWorkspace({ repoUrl: originPath, baseBranch: "main", path: wsPath });
    await ssh.run(LOCAL_HANDLE, {
      command: [
        "set -eu",
        "jj bookmark track feat --remote origin",
        `jj config set --repo 'revset-aliases."immutable_heads()"' 'none()'`,
      ].join(" && "),
      cwd: wsPath,
      timeoutMs: 60_000,
    });
    const rebase = await core.rebaseOnto(ws, "feat", "main2@origin");
    expect(rebase.outcome).toBe("clean");
    // The rebased head is a NEW sha (the rebase rewrote feat onto main2) — distinct from the
    // pristine forge head, and at this point it exists ONLY locally.
    expect(rebase.headSha).not.toBe(featSha);
    // The forge head is STILL un-rebased at this point (the rebase is local-only pre-push).
    expect(await onForge(originPath, "feat")).toBe(featSha);

    await core.exportCleanGitRef(ws, "feat");
    // §3.1 PUSH: the SAME shared push machinery the provider's `publishCleanRebase` uses
    // (anonymous push to the local origin — no token/installation).
    await pushJjHead({
      ssh,
      target: LOCAL_HANDLE,
      workspacePath: wsPath,
      secrets: {} as never,
      vcsProvider: {} as never,
      repoUrl: originPath,
      headBranch: "feat",
      githubCredentialRef: "",
      timeoutMs: 60_000,
    });

    // The ORIGIN's `feat` now points at the rebased head — the rebase was PUSHED, not left
    // local-only (the bug the re-gate then verified against the stale forge tree).
    expect(await onForge(originPath, "feat")).toBe(rebase.headSha);
  });
});

/** The sha the origin's branch points at (the colocate origin is a real git repo). */
async function onForge(originPath: string, branch: string): Promise<string> {
  return git(originPath, ["rev-parse", branch]).trim();
}
