// The apex v71 halt closer: prepareCleanPrBranch SQUASHES the writer's per-subtask
// commit range into ONE composed commit before rebasing onto the clone HEAD, so an
// inter-writer-commit self-conflict (the linear replay's `Rebasing (1/22) → (2/22)`
// halt at commit 3 on 2026-07-02 run_bcf3af59) cannot block the clean-PR prep. This is
// the git behavior the sibling scripted-SSH test (workspaceBootstrapArtifacts.test.ts)
// can't prove — the fix is entirely in the shell command's rebase semantics. We drive
// it against a REAL git repo via LocalCommandSubstrate and assert the resulting
// PR_CLEAN_REF tree + parent + message.
//
// apex v71 evidence:
//   run_bcf3af59 (v71_postgres_1) — the writer emitted 22 subtask commits, the entire
//   inner loop closed clean (checker complete, tier-2 12/12, auditor findings empty,
//   designOracle verdict, plan.completed), and the run halted at:
//     prepare clean PR branch failed: exit 1
//     command: git rebase --autostash --onto 'a7d0e59a...' 'c7080406...'
//     stderr: Rebasing (1/22) → (2/22) → (3/22)
//             error: could not apply f27ffc8... codex writer
//             hint: Resolve all conflicts manually.
//
// The doctrine-aligned fix (per docs/architecture/tanren-owns-the-engine.md — jj-only
// on Tanren's local WorkspaceVcsCore; the RUNNER-side workspace here is a git checkout
// since the PR-branch it produces is pushed to the git-based forge): squash the
// bootstrapSha..HEAD range into a single composed commit, then rebase THAT one commit —
// N distinct 3-way merges collapse into one, and any inter-commit self-conflict is
// eliminated by construction.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PR_CLEAN_REF, prepareCleanPrBranch } from "../src/engine/workspace/githubPush.js";
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

describe("prepareCleanPrBranch — squash writer commits before clean-PR rebase (apex v71 fix)", () => {
  it("NON-conflicting: N writer commits collapse to ONE composed commit whose parent is cloneHead and whose tree carries only the writer's changes (no bootstrap artifacts)", async () => {
    // Baseline invariant: the PR head is ONE composed commit, regardless of how many
    // writer subtask commits emitted. Each subtask edits DIFFERENT files here so a linear
    // rebase would ALSO succeed — the point is not conflict-avoidance in this case, but the
    // SHAPE of PR_CLEAN_REF: one commit off cloneHead with the writer's tree contribution,
    // no `bootstrap.package-lock.json` leakage. This is the invariant reviewers rely on
    // (one commit per unit of work).
    const { repoPath } = initFixtureRepo();

    writeFileAt(repoPath, "README.md", "# base\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "base"]);
    const cloneHead = git(repoPath, ["rev-parse", "HEAD"]);

    // Bootstrap adds an install artifact — the file the PR head MUST drop.
    writeFileAt(repoPath, "package-lock.json", '{"lockfileVersion": 3}\n');
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "bootstrap: npm install artifacts"]);
    const bootstrapSha = git(repoPath, ["rev-parse", "HEAD"]);

    // Three writer subtask commits — different files, no conflict potential.
    writeFileAt(repoPath, "src/status.ts", "export function status() { return 'ok'; }\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "writer: scaffold status endpoint"]);
    writeFileAt(repoPath, "src/config.ts", "export const config = {};\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "writer: scaffold config module"]);
    writeFileAt(repoPath, "src/logger.ts", "export const log = console.log;\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "writer: scaffold logger module"]);
    const writerHead = git(repoPath, ["rev-parse", "HEAD"]);
    const writerHeadTree = git(repoPath, ["rev-parse", "HEAD^{tree}"]);

    const substrate = new LocalCommandSubstrate();
    const result = await prepareCleanPrBranch({
      ssh: substrate,
      target: LOCAL_HANDLE,
      workspacePath: repoPath,
      cloneHeadSha: cloneHead,
      bootstrapSha,
      runId: "run_non_conflict",
    });

    expect(result.ref).toBe(PR_CLEAN_REF);
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/u);

    // ONE composed commit off cloneHead — the PR-per-unit-of-work invariant.
    const commitCount = git(repoPath, ["rev-list", "--count", `${cloneHead}..${PR_CLEAN_REF}`]);
    expect(commitCount).toBe("1");

    // Parent = cloneHead: the composed commit rebased onto the base the PR opens against.
    const parent = git(repoPath, ["rev-parse", `${PR_CLEAN_REF}^`]);
    expect(parent).toBe(cloneHead);

    // The tree EXCLUDES the bootstrap artifact (`package-lock.json` was introduced by
    // bootstrapSha alone; the cumulative bootstrap..HEAD diff doesn't re-introduce it, so
    // 3-way merged with cloneHead the file is DROPPED — the whole point of the clean-PR
    // prep) but INCLUDES every writer-authored file.
    const treeListing = git(repoPath, ["ls-tree", "-r", "--name-only", PR_CLEAN_REF]);
    expect(treeListing).not.toContain("package-lock.json");
    expect(treeListing).toContain("src/status.ts");
    expect(treeListing).toContain("src/config.ts");
    expect(treeListing).toContain("src/logger.ts");

    // The working HEAD is RESTORED to the writer tip — a review-rework re-entry must keep
    // its bootstrapSha diff base intact. prepareCleanPrBranch must never strand HEAD.
    const finalHead = git(repoPath, ["rev-parse", "HEAD"]);
    expect(finalHead).toBe(writerHead);
    const finalHeadTree = git(repoPath, ["rev-parse", "HEAD^{tree}"]);
    expect(finalHeadTree).toBe(writerHeadTree);
  });

  it("apex v71 halt shape: LINEAR rebase FAILS (modify/delete conflict on a writer-modified bootstrap file), SQUASH-then-rebase SUCCEEDS", async () => {
    // The v71 halt was `error: could not apply <sha> codex writer` — a 3-way merge conflict
    // partway through the linear replay. Reproduced HERE by a fixture where the writer
    // MODIFIES a file the bootstrap created: the linear replay auto-merges the earlier
    // commits into a tip WITHOUT the bootstrap file (cloneHead never had it), then the next
    // commit that MODIFIES that same file hits a modify/delete conflict against the tip.
    //
    // The squash reduces N linear applications (each a chance to conflict) to ONE 3-way
    // merge over the CUMULATIVE bootstrap..HEAD diff — and when the writer's cumulative
    // change over the bootstrap file EQUALS the cloneHead-vs-bootstrap deletion (both
    // remove it), the 3-way merge trivially resolves.
    const { repoPath } = initFixtureRepo();

    writeFileAt(repoPath, "README.md", "# base\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "base"]);
    const cloneHead = git(repoPath, ["rev-parse", "HEAD"]);

    // Bootstrap creates BOTH a lockfile AND a scaffold file. The scaffold file is what
    // the writer commits will modify then eventually drop — the modify/delete shape.
    writeFileAt(repoPath, "package-lock.json", '{"lockfileVersion": 3}\n');
    writeFileAt(repoPath, "src/scaffold.ts", "export const scaffold = 'bootstrap-initial';\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "bootstrap: install artifacts + scaffold"]);
    const bootstrapSha = git(repoPath, ["rev-parse", "HEAD"]);

    // Writer commits:
    //   c1: introduces a helper (touches only NEW file) — linear-rebases cleanly.
    //   c2: modifies the bootstrap-created scaffold — under linear rebase, tip has NO
    //       scaffold.ts (cloneHead lacks it, c1's auto-merge kept it absent), so this
    //       hits `modify/delete: scaffold.ts deleted in HEAD and modified in c2`. This
    //       IS the v71 halt shape.
    //   c3: normalizes: deletes the bootstrap scaffold entirely. The cumulative diff
    //       becomes `delete scaffold.ts + add helper.ts` — trivially applies to cloneHead
    //       under the squash-then-rebase path.
    writeFileAt(repoPath, "src/helper.ts", "export const helper = () => true;\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "writer: add helper module"]);
    writeFileAt(repoPath, "src/scaffold.ts", "export const scaffold = 'writer-modified';\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "writer: refine scaffold module"]);
    rmSync(join(repoPath, "src/scaffold.ts"));
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "writer: drop scaffold in favor of helper"]);
    const writerHead = git(repoPath, ["rev-parse", "HEAD"]);

    // FIRST prove the OLD LINEAR rebase would fail on this same fixture (documenting the
    // exact halt shape this test is closing). Stage a detached copy at writerHead and run
    // the pre-fix command shape — it MUST fail, otherwise the fixture doesn't reproduce v71.
    git(repoPath, ["checkout", "--quiet", "--detach", writerHead]);
    let linearFailure: string | undefined;
    try {
      execFileSync("git", ["rebase", "--onto", cloneHead, bootstrapSha], {
        cwd: repoPath,
        env: gitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      linearFailure = (error as { stderr?: Buffer }).stderr?.toString() ?? "linear rebase failed";
    }
    // If the linear rebase DIDN'T fail, this fixture no longer reproduces the v71 halt shape —
    // fail loud rather than silently pass an ineffective assertion.
    expect(linearFailure).toBeDefined();
    // Concretely a modify/delete conflict — the exact class the v71 halt fell into.
    expect(linearFailure).toMatch(/CONFLICT|could not apply/u);
    // Abort the failed rebase so the workspace is usable for the fix path below.
    execFileSync("git", ["rebase", "--abort"], { cwd: repoPath, env: gitEnv(), stdio: "ignore" });
    // Restore the writer branch tip so prepareCleanPrBranch runs from the same starting state.
    git(repoPath, ["checkout", "--quiet", "--detach", writerHead]);

    // NOW the FIX path: squash-then-rebase MUST succeed on the same fixture.
    const substrate = new LocalCommandSubstrate();
    const result = await prepareCleanPrBranch({
      ssh: substrate,
      target: LOCAL_HANDLE,
      workspacePath: repoPath,
      cloneHeadSha: cloneHead,
      bootstrapSha,
      runId: "run_bcf3af59",
    });

    expect(result.ref).toBe(PR_CLEAN_REF);
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/u);

    // ONE composed commit off cloneHead — the linear-conflict class is eliminated.
    const commitCount = git(repoPath, ["rev-list", "--count", `${cloneHead}..${PR_CLEAN_REF}`]);
    expect(commitCount).toBe("1");
    const parent = git(repoPath, ["rev-parse", `${PR_CLEAN_REF}^`]);
    expect(parent).toBe(cloneHead);

    // The composed tree carries the writer's FINAL state (helper present, scaffold dropped),
    // and none of the bootstrap-only artifacts (package-lock.json).
    const treeListing = git(repoPath, ["ls-tree", "-r", "--name-only", PR_CLEAN_REF]);
    expect(treeListing).toContain("src/helper.ts");
    expect(treeListing).not.toContain("src/scaffold.ts");
    expect(treeListing).not.toContain("package-lock.json");
  });

  it("the composed commit's message carries provenance: the runId + the per-subtask commit subjects (in writer order)", async () => {
    // The composed commit is the PR head; reviewers see it as ONE change. It MUST carry
    // enough provenance to trace back to the writer's per-subtask trail — the runId anchors
    // the events table lookup (`writer.subtask.completed[]`), and the `- <subject>` bullets
    // enumerate the drafts that contributed, in chronological order (writer-order — the
    // `--reverse` on `git log` guarantees this).
    const { repoPath } = initFixtureRepo();

    writeFileAt(repoPath, "README.md", "# base\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "base"]);
    const cloneHead = git(repoPath, ["rev-parse", "HEAD"]);

    writeFileAt(repoPath, "package-lock.json", "{}\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "bootstrap"]);
    const bootstrapSha = git(repoPath, ["rev-parse", "HEAD"]);

    // Three writer subtask commits — distinct intent lines that must ALL surface in the
    // composed commit's message body, in the order they were authored.
    for (const intent of ["scaffold status endpoint", "scaffold config module", "scaffold logger module"]) {
      writeFileAt(repoPath, `src/${intent.split(" ")[1] ?? "x"}.ts`, `// ${intent}\n`);
      git(repoPath, ["add", "-A"]);
      git(repoPath, ["commit", "--quiet", "-m", `writer: ${intent}`]);
    }

    const substrate = new LocalCommandSubstrate();
    const result = await prepareCleanPrBranch({
      ssh: substrate,
      target: LOCAL_HANDLE,
      workspacePath: repoPath,
      cloneHeadSha: cloneHead,
      bootstrapSha,
      runId: "run_apex_v71_provenance",
    });

    const composedMessage = git(repoPath, ["log", "-1", "--format=%B", result.headSha]);

    // The runId anchors provenance back to the run (the `writer.subtask.completed[]` trail).
    expect(composedMessage).toContain("run_apex_v71_provenance");
    // Each writer subtask's commit subject appears as a `- <subject>` bullet.
    expect(composedMessage).toContain("- writer: scaffold status endpoint");
    expect(composedMessage).toContain("- writer: scaffold config module");
    expect(composedMessage).toContain("- writer: scaffold logger module");
    // The bullets appear in WRITER order — earliest subtask first — so a reviewer reads the
    // narrative in the same order the writer authored it. This is what `git log --reverse`
    // in the shell guarantees; assert it here so a regression that drops `--reverse` fails loud.
    const statusIdx = composedMessage.indexOf("- writer: scaffold status endpoint");
    const configIdx = composedMessage.indexOf("- writer: scaffold config module");
    const loggerIdx = composedMessage.indexOf("- writer: scaffold logger module");
    expect(statusIdx).toBeGreaterThan(-1);
    expect(configIdx).toBeGreaterThan(statusIdx);
    expect(loggerIdx).toBeGreaterThan(configIdx);
  });

  it("rejects an empty runId — the composed commit's provenance requires a non-empty anchor", async () => {
    // No-fallback doctrine: an empty runId would produce a composed commit with a blank
    // `(  )` anchor, silently defeating the provenance the PR head is meant to carry back to
    // the events table. Fail loud rather than emit a provenance-less commit.
    const substrate = new LocalCommandSubstrate();
    await expect(
      prepareCleanPrBranch({
        ssh: substrate,
        target: LOCAL_HANDLE,
        workspacePath: "/unused-fake-ssh-path",
        // The runId guard fires BEFORE any SSH call, so the shas + workspacePath are ignored.
        cloneHeadSha: "a".repeat(40),
        bootstrapSha: "b".repeat(40),
        runId: "",
      }),
    ).rejects.toThrow(/non-empty runId/u);
  });
});
