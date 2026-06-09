// Shared cwd-isolation hardening for the REAL-git test fixtures
// (gitWorkspaceFixtureRepo.ts, jjConflictApplierFixtureRepo.ts) — and the same scrub
// the LocalCommandSubstrate applies to every jj/git child it spawns.
//
// WHY THIS EXISTS (a live branch-corruption incident): a fixture builds its repo with
// `execFileSync("git", …, { cwd: tempDir })`, which LOOKS isolated. But git's
// repo-selecting env vars (GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_COMMON_DIR /
// GIT_OBJECT_DIRECTORY) OVERRIDE `cwd`: if ANY of them leaks into the test process's
// environment (a git hook, a parent `git`/jj invocation, a CI runner that exports
// GIT_DIR, jj's own colocate), then `cwd: tempDir` is ignored and git targets the
// LEAKED dir instead. Observed live: the fixture's `git commit -m base` of its tiny
// seed tree landed ON THE WORKTREE'S checked-out branch via a leaked GIT_WORK_TREE —
// stripping the entire repo (deleting .dockerignore/.env.example/…) and then checking
// out `conflict-base`, corrupting the branch (a later push propagated it to the remote).
//
// THE FIX: every git/jj child a fixture spawns must (1) carry these repo-selecting vars
// UNSET so `cwd` is the SOLE thing that selects the repo, and (2) be checkable as
// confined to its temp dir. `fixtureGitEnv` builds the scrubbed env; `assertGitDirUnder`
// is the cheap defensive guard a fixture calls right after `git init` to PROVE the
// resolved git dir is under its temp root — never the host repo's real `.git`.
//
// TEST FIXTURE SUPPORT ONLY (under tests/, never src/).

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * The git environment variables that OVERRIDE the working directory when selecting the
 * repository. Any of these leaking from the ambient process redirects a `cwd`-scoped git
 * invocation onto the leaked target — the exact vector that corrupted the worktree. They
 * are UNSET (not re-pointed) for every fixture child so `cwd` is the sole repo selector.
 */
export const GIT_REPO_SELECTING_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
] as const;

/**
 * Build a child-process env from `base` with the deterministic Fixture author identity and
 * — critically — the {@link GIT_REPO_SELECTING_ENV_VARS} scrubbed to `undefined`, so a leaked
 * GIT_DIR/GIT_WORK_TREE can NEVER redirect a `cwd`-scoped git op onto the host worktree.
 */
export function fixtureGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@local",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@local",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  for (const name of GIT_REPO_SELECTING_ENV_VARS) {
    delete env[name];
  }
  return env;
}

/** Remove the git repo-selecting vars from an env object in place (for shells/substrates). */
export function stripGitRepoSelectingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of GIT_REPO_SELECTING_ENV_VARS) {
    delete env[name];
  }
  return env;
}

/**
 * DEFENSIVE GUARD: assert the git repo `cwd` actually resolves to is UNDER `tempRoot`,
 * never the host worktree. Run right after `git init` — `git rev-parse --git-dir` reports
 * the dir git selected (which the leaked repo-selecting vars would override), so an escape is
 * caught LOUDLY before any commit can land on the worktree's branch. Throws on escape.
 */
export function assertGitDirUnder(cwd: string, tempRoot: string, env: NodeJS.ProcessEnv): void {
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, env, encoding: "utf8" }).trim();
  const real = realpathSync(gitDir);
  const realRoot = realpathSync(tempRoot);
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (real !== realRoot && !resolve(real).startsWith(prefix)) {
    throw new Error(
      `fixture git isolation BREACH: git dir resolved to ${real}, OUTSIDE the fixture temp root ${realRoot} ` +
        `(a leaked GIT_DIR/GIT_WORK_TREE would have committed onto the host worktree's branch)`,
    );
  }
}
