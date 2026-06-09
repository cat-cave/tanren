// Builds a REAL local git fixture repo for the Wave-1 WorkspaceVcsCore conformance
// so the jj impl runs against actual VCS plumbing (`jj git clone` of this bare repo,
// not a scripted echo). The conformance harness passes synthetic base shas
// `conflict-base-sha` / `clean-base-sha`; the jj test's ref-resolver maps them onto
// the bookmarks jj imports from this fixture's git branches:
//   - `main`           — base branch; `src/conflicted.ts` = "base\n".
//   - `conflict-base`  — edits `src/conflicted.ts` to "theirs\n" (conflicts with a
//                        feature commit that ALSO edits `src/conflicted.ts`).
//   - `clean-base`     — edits an UNRELATED file (README.md), so a rebase onto it is
//                        a clean 3-way merge.
// TEST FIXTURE ONLY (under tests/, never src/).

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGitDirUnder, fixtureGitEnv } from "./fixtureGitEnv.js";

export interface GitFixture {
  /** The bare repo path the impl `jj git clone`s. */
  originPath: string;
  /** A scratch dir under which each workspace `path` is made unique. */
  scratchRoot: string;
}

// The git env every fixture child runs under: the deterministic Fixture author PLUS the
// git repo-selecting vars (GIT_DIR/GIT_WORK_TREE/…) SCRUBBED, so a leaked one can never redirect
// a `cwd`-scoped git op onto the host worktree (the live branch-corruption vector). Read
// from `process.env` at CALL time (not module load) so a leak present whenever the fixture
// runs is scrubbed — not just one captured at import.
function gitEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv(process.env);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: gitEnv(),
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** Create a fresh fixture repo (origin + conflict/clean base refs) in a temp dir. */
export function makeGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "tanren-wvcs-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
  // DEFENSIVE GUARD: prove `git init` selected the temp seed dir — not a leaked GIT_DIR /
  // the host worktree's real `.git` — BEFORE any commit can land on the worktree's branch.
  assertGitDirUnder(work, root, gitEnv());
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src", "conflicted.ts"), "base\n");
  writeFileSync(join(work, "README.md"), "readme\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);

  // conflict-base: edits the SAME file a feature commit will edit → real conflict.
  git(work, ["checkout", "--quiet", "-b", "conflict-base"]);
  writeFileSync(join(work, "src", "conflicted.ts"), "theirs\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "conflict base edit"]);

  // clean-base: edits an UNRELATED file → clean 3-way merge.
  git(work, ["checkout", "--quiet", "main"]);
  git(work, ["checkout", "--quiet", "-b", "clean-base"]);
  writeFileSync(join(work, "README.md"), "readme + clean base\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "clean base edit"]);

  git(work, ["checkout", "--quiet", "main"]);
  // Publish a bare origin the impl `jj git clone`s.
  git(work, ["clone", "--quiet", "--bare", work, originPath]);

  return { originPath, scratchRoot: root };
}
