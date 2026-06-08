// A REAL local git fixture for the jj conflict-applier behavior tests
// (jjWorkspaceApplier.ts, tanren-owns-the-engine.md §2/§5). It models the live
// merge-time shape: a `main` base branch that ADVANCED after a `feature` PR branch
// was cut, so rebasing `feature` onto the advanced base either conflicts (both edited
// the same file) or is clean (the feature edited an unrelated file). The applier
// `jj git clone`s this bare origin, rebases the head onto `main@origin`, resolves, and
// pushes the resolution back — all over a REAL jj process in a temp dir.
//
// TEST FIXTURE ONLY (under tests/, never src/). cwd-isolation discipline: every dir is
// under a fresh `mkdtemp` temp root so a fixture can never touch the host repo.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface JjApplierFixture {
  /** The bare repo the applier `jj git clone`s (also the push remote). */
  originPath: string;
  /** A fresh temp dir the applier's workspace clones INTO (non-pre-created child path). */
  workspacePath: string;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@local",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@local",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/**
 * Build the fixture. `conflicting` ⇒ the feature edits the SAME file the advanced base
 * touched (a real rebase conflict); `!conflicting` ⇒ the feature edits an UNRELATED file
 * (a clean rebase, no conflict recorded). The bare origin allows pushes (a non-bare
 * checkout would refuse the resolution push).
 */
export function makeJjApplierFixture(opts: { conflicting: boolean }): JjApplierFixture {
  const root = mkdtempSync(join(tmpdir(), "tanren-jjapplier-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(join(work, "src"), { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(work, "src", "conflicted.ts"), "base\n");
  writeFileSync(join(work, "README.md"), "readme\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);

  // Cut the PR head branch from the base, editing one file.
  git(work, ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(join(work, opts.conflicting ? "src/conflicted.ts" : "src/feature.ts"), "ours\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "feature work"]);

  // The base ADVANCES after the head was cut — editing src/conflicted.ts, so a
  // conflicting feature collides on rebase and a clean feature does not.
  git(work, ["checkout", "--quiet", "main"]);
  writeFileSync(join(work, "src", "conflicted.ts"), "theirs\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base advanced"]);

  // Bare origin (push-allowing) the applier clones. `--bare` of a repo with both
  // branches publishes `main` (HEAD) + `feature`.
  git(work, ["clone", "--quiet", "--bare", work, originPath]);

  return { originPath, workspacePath: join(root, "ws") };
}
