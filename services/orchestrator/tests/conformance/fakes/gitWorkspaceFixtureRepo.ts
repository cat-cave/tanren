// Builds a REAL local git fixture repo for the Wave-1 WorkspaceVcsCore conformance
// so the git/jj impls run against actual VCS plumbing (not a scripted echo). The
// conformance harness passes synthetic tokens — a `repoUrl` of
// `https://example.com/...` and base shas `conflict-base-sha` / `clean-base-sha`; a
// ref-resolver (built here) maps them onto this fixture's real refs:
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
import type { GitRefResolver } from "../../../src/engine/providers/gitWorkspaceVcsCore.js";

export interface GitFixture {
  /** The bare repo path the impl clones (the resolver maps the synthetic URL here). */
  originPath: string;
  /** Maps the conformance's synthetic tokens onto this fixture's real refs. */
  refResolver: GitRefResolver;
  /** A scratch dir under which each workspace `path` is made unique. */
  scratchRoot: string;
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

/** Create a fresh fixture repo (origin + conflict/clean base refs) in a temp dir. */
export function makeGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "tanren-wvcs-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
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
  // Publish a bare origin the impl can `git clone`.
  git(work, ["clone", "--quiet", "--bare", work, originPath]);

  const refResolver: GitRefResolver = {
    cloneSource: () => originPath,
    baseRevision: (baseSha) => {
      if (baseSha.startsWith("conflict-")) return "origin/conflict-base";
      if (baseSha.startsWith("clean-")) return "origin/clean-base";
      return baseSha;
    },
  };

  return { originPath, refResolver, scratchRoot: root };
}
