// §3.5 LOCK (docs/audits/2026-06-09-apex-pre-run.md): the jj-LOCAL batch integration must
// PREP each member's bookmark before rebasing it (track the remote bookmark as a mutable
// LOCAL one + empty the immutable set) and read the post-rebase head from the LOCAL rev —
// else jj refuses ("would rewrite immutable commits") on the remote-tracking bookmark, OR
// reads the un-rebased remote head. Driven against a REAL `jj` process (the
// LocalCommandSubstrate) over a real multi-member git fixture — NOT a scripted echo.
//
// WITHOUT the fix the first member rebase wedges the whole batch (the apex multi-PR merge
// wave): this test proves a two-member stack integrates CLEAN, the head advances, and the
// member-head divergence keys are the PRISTINE pre-integration remote heads.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveJjWorkspace } from "../src/engine/providers/liveJjWorkspace.js";
import { JjWorkspaceVcsCore } from "../src/engine/providers/jjWorkspaceVcsCore.js";
import { integrateOverWorkspace } from "../src/engine/dag/jjLocalIntegration.js";
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

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: gitEnv(),
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/**
 * A real bare git origin with `main` + two member branches (`feat-a`, `feat-b`), each
 * editing a DISTINCT file off `main` so they stack onto the base CLEANLY (the apex
 * common case: independent PRs in one batch). The members are published branches jj
 * imports as REMOTE bookmarks — exactly the immutable-rewrite trap §3.5 closes.
 */
function makeBatchFixture(): { originPath: string } {
  const root = mkdtempSync(join(tmpdir(), "tanren-jj-local-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
  // DEFENSIVE GUARD: prove `git init` selected the temp seed dir — not a leaked GIT_DIR /
  // the host worktree's real `.git` — BEFORE any commit can land on the worktree's branch.
  assertGitDirUnder(work, root, gitEnv());
  writeFileSync(join(work, "base.txt"), "base\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);

  git(work, ["checkout", "--quiet", "-b", "feat-a"]);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "feat a"]);

  git(work, ["checkout", "--quiet", "main"]);
  git(work, ["checkout", "--quiet", "-b", "feat-b"]);
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "feat b"]);

  git(work, ["checkout", "--quiet", "main"]);
  git(work, ["clone", "--quiet", "--bare", work, originPath]);
  return { originPath };
}

/** A LiveJjWorkspace over the REAL jj CLI on the local substrate (anonymous clone of a local fixture). */
function liveLocalJj(): LiveJjWorkspace {
  const scratch = mkdtempSync(join(tmpdir(), "tanren-jj-local-ws-"));
  const core = new JjWorkspaceVcsCore({
    substrate: new LocalCommandSubstrate(),
    target: LOCAL_HANDLE,
    timeoutMs: 60_000,
  });
  return {
    core,
    target: LOCAL_HANDLE,
    workspacePath: join(scratch, "ws"),
    tokenSource: "anonymous",
    release: async () => {},
  };
}

describe("§3.5 jj-local batch integration (real jj)", () => {
  it("stacks two member bookmarks CLEAN — bookmark prep + LOCAL head read-back (no immutable refusal)", async () => {
    const { originPath } = makeBatchFixture();
    const live = liveLocalJj();
    const ssh = new LocalCommandSubstrate();

    const result = await integrateOverWorkspace(live, ssh, {
      baseBranch: "main",
      repoUrl: originPath,
      members: [
        { specId: "spec-a", branch: "feat-a" },
        { specId: "spec-b", branch: "feat-b" },
      ],
      localRef: "tanren-batch-test",
      timeoutMs: 60_000,
    });

    // The integration is CLEAN — WITHOUT the bookmark-track + immutable-heads prep the first
    // member rebase would refuse ("would rewrite immutable commits") and the batch would wedge.
    expect(result.outcome).toBe("integrated");
    if (result.outcome !== "integrated") return;
    // A real 40-hex integrated head + tree (read from the LOCAL rev after rebase — the
    // remote-tracking ref would have yielded the un-rebased head).
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.treeHash).not.toBe("");
    // The member-head divergence keys are the PRISTINE pre-integration remote heads (read
    // from `<branch>@origin`, which the local rebase never advanced) — two distinct shas.
    expect(result.memberHeadShas["spec-a"]).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.memberHeadShas["spec-b"]).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.memberHeadShas["spec-a"]).not.toBe(result.memberHeadShas["spec-b"]);
    // The integrated head is NOT either pristine member head (it is the stacked result).
    expect(result.headSha).not.toBe(result.memberHeadShas["spec-a"]);
    expect(result.headSha).not.toBe(result.memberHeadShas["spec-b"]);
  });
});
