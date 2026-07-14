// Real-git coverage for prepareCleanPrBranch's DIRECT OVERLAY (apex v85): build ONE
// composed commit parented on cloneHead whose tree is cloneHead + (writer − bootstrap)
// via a private-index path overlay — no rebase, no checkout, no HEAD move. This is the
// git behavior the sibling scripted-SSH test (workspaceBootstrapArtifacts.test.ts) can't
// prove. We drive a REAL git repo via LocalCommandSubstrate and assert PR_CLEAN_REF
// tree + parent + message.
//
// History:
//   v71 — squash writer N commits → one commit, then rebase onto cloneHead. Closed
//         inter-writer draft self-conflicts (linear `Rebasing (1/22)…(3/22) could not
//         apply` on run_bcf3af59). Still used a 3-way merge for that one commit.
//   v85 — even ONE composed commit can 3-way-conflict when bootstrap diverges from
//         cloneHead on paths the writer also touched (`Rebasing (1/1) could not apply
//         … Tanren composed change` on scaffold run_63b8e8aa). Direct overlay drops
//         the rebase; writer-wins path apply cannot conflict.
//
// Doctrine (tanren-owns-the-engine.md): jj-only on Tanren's local WorkspaceVcsCore; the
// RUNNER-side workspace here is a git checkout because the PR branch is pushed to the
// git-based forge.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCleanPrBranch } from "../src/engine/workspace/githubPush.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./conformance/fakes/localCommandSubstrate.js";
import { assertGitDirUnder, fixtureGitEnv } from "./conformance/fakes/fixtureGitEnv.js";

// The git env every fixture child runs under: deterministic Fixture author + git repo-
// selecting vars SCRUBBED (a leaked GIT_DIR/GIT_WORK_TREE cannot redirect a `cwd`-scoped
// git op onto the host worktree — the live branch-corruption vector). Read `process.env`
// at CALL time so any leak present when the fixture runs is scrubbed.
function gitEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv(process.env);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "inherit"],
  })
    .toString()
    .trim();
}

// Write a file, creating parent dirs as needed. The writer commits below sometimes place
// files under `src/` so the fixture needs the parent dir before the write.
function writeFileAt(cwd: string, relPath: string, content: string): void {
  mkdirSync(dirname(join(cwd, relPath)), { recursive: true });
  writeFileSync(join(cwd, relPath), content);
}

// Create a fresh temp repo dir + `git init` it under a scrubbed env, with the defensive
// guard that the resolved `.git` is under the fixture root (never the host worktree).
function initFixtureRepo(): { root: string; repoPath: string } {
  const root = mkdtempSync(join(tmpdir(), "tanren-squash-"));
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "--quiet", "--initial-branch=main"]);
  assertGitDirUnder(repoPath, root, gitEnv());
  return { root, repoPath };
}

describe("prepareCleanPrBranch — composed PR-head commit identity attribution (apex v91 merge-block)", () => {
  function seedGreenfieldFixture(): { repoPath: string; cloneHead: string; bootstrapSha: string } {
    const { repoPath } = initFixtureRepo();
    writeFileAt(repoPath, "README.md", "# base\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "base"]);
    const cloneHead = git(repoPath, ["rev-parse", "HEAD"]);
    writeFileAt(repoPath, "package-lock.json", "{}\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "bootstrap"]);
    const bootstrapSha = git(repoPath, ["rev-parse", "HEAD"]);
    writeFileAt(repoPath, "src/app.ts", "export const app = true;\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "writer: scaffold app"]);
    return { repoPath, cloneHead, bootstrapSha };
  }

  it("ATTRIBUTABLE: with a resolved pushIdentity the composed PR-head commit is authored + committed as the bot login + its canonical noreply email (not composer@tanren.invalid)", async () => {
    const { repoPath, cloneHead, bootstrapSha } = seedGreenfieldFixture();
    // The identity `resolveVcsActorIdentity` yields for the run's App installation: the bot
    // login + the canonical `<bot-user-id>+<login>@users.noreply.github.com` GitHub maps back
    // to the login. The `[bot]` + `+` chars must survive shell quoting intact.
    const pushIdentity = {
      login: "linky91-app[bot]",
      id: "99001",
      noreplyEmail: "99001+linky91-app[bot]@users.noreply.github.com",
    };

    const result = await prepareCleanPrBranch({
      ssh: new LocalCommandSubstrate(),
      target: LOCAL_HANDLE,
      workspacePath: repoPath,
      cloneHeadSha: cloneHead,
      bootstrapSha,
      runId: "run_attributable",
      pushIdentity,
    });
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/u);

    // The PR-head commit attributes to the bot login — GitHub maps the noreply email back to
    // it, so the PR-commit author is populated (never `null`/`<unknown>`).
    expect(git(repoPath, ["log", "-1", "--format=%an", result.headSha])).toBe(pushIdentity.login);
    expect(git(repoPath, ["log", "-1", "--format=%ae", result.headSha])).toBe(pushIdentity.noreplyEmail);
    expect(git(repoPath, ["log", "-1", "--format=%cn", result.headSha])).toBe(pushIdentity.login);
    expect(git(repoPath, ["log", "-1", "--format=%ce", result.headSha])).toBe(pushIdentity.noreplyEmail);
    // Regression pin on the exact apex-v91 root cause: the composed commit must NOT carry the
    // unattributable placeholder that mapped to a `null` GitHub login → `<unknown>` → block.
    expect(git(repoPath, ["log", "-1", "--format=%ae", result.headSha])).not.toBe("composer@tanren.invalid");
  });

  it("FALLBACK: with no pushIdentity (the genuinely unauthenticated clone) the composed commit keeps the non-attributable Tanren Composer placeholder (that path never pushes as Tanren)", async () => {
    const { repoPath, cloneHead, bootstrapSha } = seedGreenfieldFixture();
    const result = await prepareCleanPrBranch({
      ssh: new LocalCommandSubstrate(),
      target: LOCAL_HANDLE,
      workspacePath: repoPath,
      cloneHeadSha: cloneHead,
      bootstrapSha,
      runId: "run_unauthenticated",
    });
    expect(git(repoPath, ["log", "-1", "--format=%an", result.headSha])).toBe("Tanren Composer");
    expect(git(repoPath, ["log", "-1", "--format=%ae", result.headSha])).toBe("composer@tanren.invalid");
  });
});
