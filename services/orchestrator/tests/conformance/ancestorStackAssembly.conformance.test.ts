// CONFORMANCE for the jj-LOCAL BOOTSTRAP ASSEMBLY (walker-jj-local-integration-design.md
// §2.1, §7 PR-3) — the dependent-run counterpart of the batch path's
// `jjLocalIntegration.realjj.test.ts`. Driven against a REAL `jj` process (the
// LocalCommandSubstrate) over a real multi-ancestor git fixture — NOT a scripted echo —
// so it pins the SAME assembly mechanics the batch path proves, plus the ONE new step:
// the dependent's run branch is created AT the assembled head (the workspace then stays
// OPEN for the writer loop).
//
// The cases mirror the design's PR-3 acceptance criteria:
//   1. ORDERED N-ANCESTOR STACK — a `[A, B]` ancestor stack assembles `main + A + B` in
//      DAG order; the run branch is created at that head; the head + tree materialize.
//   2. CONFLICT SURFACES — two ancestors editing the SAME file (spec-vs-spec) surface the
//      SAME `conflict` outcome the batch path returns; the workspace is RELEASED (nothing
//      handed off) so the walker can HOLD the dependent.
//   3. NEVER-DISCARD — the assembled head carries EVERY ancestor's content as its history
//      prefix (the dependent has no commits yet at bootstrap, so "never-discard" = the
//      assembled head == `main + ancestors`, and the run branch is created AT that head —
//      its parent is the assembled head, its tree carries every ancestor file).
//   4. CLEAN HEAD, NO HOST REF — a clean assembly materializes a real head with NO ref
//      pushed to the host (the assembly is a runner-local jj bookmark) and KEEPS the
//      workspace open (the writer's workspace), releasing only when the caller asks.
//
// GIT_DIR-LEAK GUARD (#506): every git fixture child runs under the scrubbed
// `fixtureGitEnv` + the post-`git init` `assertGitDirUnder` guard, so a leaked
// GIT_DIR/GIT_WORK_TREE can never redirect a `cwd`-scoped git op onto the host worktree.
// (jj children are scrubbed by the LocalCommandSubstrate.)

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AncestorStack } from "../../src/engine/dag/ancestorStack.js";
import {
  type AncestorPhaseBySpecId,
  bootstrapDependentBase,
  bootstrapLocalIntegrationRef,
  type BootstrapDependentBaseInput,
} from "../../src/engine/dag/jjLocalBootstrap.js";
import type { LiveJjWorkspace, LiveJjWorkspaceDeps } from "../../src/engine/providers/liveJjWorkspace.js";
import { JjWorkspaceVcsCore } from "../../src/engine/providers/jjWorkspaceVcsCore.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./fakes/localCommandSubstrate.js";
import { assertGitDirUnder, fixtureGitEnv } from "./fakes/fixtureGitEnv.js";

// The git env every fixture child runs under: the deterministic Fixture author PLUS the git
// repo-selecting vars (GIT_DIR/GIT_WORK_TREE/…) SCRUBBED. Read at CALL time (not module load)
// so a leak present whenever the fixture runs is scrubbed — not just one captured at import.
function gitEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv(process.env);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "ignore", "inherit"] });
}

/** Commit a single file onto the current branch in the fixture seed work tree. */
function commitFile(work: string, file: string, contents: string, message: string): void {
  writeFileSync(join(work, file), contents);
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", message]);
}

/**
 * A real bare git origin with `main` + ordered ancestor branches off `main`. Each
 * `branchFiles[i]` becomes a published branch `feat-<i>` editing the given file(s) — the
 * ancestor PR-head branches jj imports as REMOTE bookmarks (the immutable-rewrite trap
 * §3.5 closes). DISTINCT files ⇒ a CLEAN stack; the SAME file across two branches ⇒ the
 * spec-vs-spec conflict case.
 */
function makeAncestorFixture(branchFiles: ReadonlyArray<{ branch: string; file: string; contents: string }>): {
  originPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "tanren-jj-bootstrap-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
  // DEFENSIVE GUARD: prove `git init` selected the temp seed dir — not a leaked GIT_DIR /
  // the host worktree's `.git` — BEFORE any commit can land on the worktree's branch.
  assertGitDirUnder(work, root, gitEnv());
  commitFile(work, "base.txt", "base\n", "base");

  for (const { branch, file, contents } of branchFiles) {
    git(work, ["checkout", "--quiet", "main"]);
    git(work, ["checkout", "--quiet", "-b", branch]);
    commitFile(work, file, contents, `feat ${branch}`);
  }

  git(work, ["checkout", "--quiet", "main"]);
  git(work, ["clone", "--quiet", "--bare", work, originPath]);
  return { originPath };
}

/**
 * A LiveJjWorkspace over the REAL jj CLI on the local substrate (anonymous clone of a
 * local fixture). `release` is recorded so the keep-open / release contract is asserted —
 * an anonymous local clone NEVER pushes a host ref, so a clean assembly leaving the
 * workspace open is observable purely by `released` staying false.
 */
function liveLocalJj(): { live: LiveJjWorkspace; released: () => boolean } {
  const scratch = mkdtempSync(join(tmpdir(), "tanren-jj-bootstrap-ws-"));
  const core = new JjWorkspaceVcsCore({
    substrate: new LocalCommandSubstrate(),
    target: LOCAL_HANDLE,
    timeoutMs: 60_000,
  });
  let didRelease = false;
  const live: LiveJjWorkspace = {
    core,
    target: LOCAL_HANDLE,
    workspacePath: join(scratch, "ws"),
    tokenSource: "anonymous",
    release: async () => {
      didRelease = true;
    },
  };
  return { live, released: () => didRelease };
}

/** The bootstrap input over a local fixture origin (anonymous clone, real jj). */
function bootstrapInput(originPath: string, runBranch: string): BootstrapDependentBaseInput {
  return { repoUrl: originPath, baseBranch: "main", runBranch, timeoutMs: 60_000 };
}

/**
 * No ancestor phases — these fixtures keep every ancestor branch LIVE, so the
 * branch-gone-but-not-merged classification (the only place `ancestorPhase` is read) never
 * triggers. An empty map is the fail-closed default everywhere it would matter.
 */
const NO_PHASES: AncestorPhaseBySpecId = new Map();

/** A workspace builder port that hands back a pre-built local jj workspace (no allocation). */
function localBuilder(live: LiveJjWorkspace): (deps: LiveJjWorkspaceDeps) => Promise<LiveJjWorkspace> {
  return async () => live;
}

/** The minimal deps the bootstrap threads (only `ssh` is read by `integrateOverWorkspace`). */
function localDeps(): LiveJjWorkspaceDeps {
  return { ssh: new LocalCommandSubstrate() } as unknown as LiveJjWorkspaceDeps;
}

/** Read a ref's commit sha off the assembled local workspace (the materialized head). */
function readSha(workspacePath: string, rev: string): string {
  // The workspace is `--colocate`d, so the exported git refs exist for a stable read.
  return execFileSync("git", ["rev-parse", rev], { cwd: workspacePath, env: gitEnv(), encoding: "utf8" }).trim();
}

describe("jj-local bootstrap assembly (real jj) — ancestor-stack assembly conformance", () => {
  it("ORDERED N-ANCESTOR STACK: assembles `main + A + B` in order + creates the run branch at the head", async () => {
    const { originPath } = makeAncestorFixture([
      { branch: "feat-a", file: "a.txt", contents: "a\n" },
      { branch: "feat-b", file: "b.txt", contents: "b\n" },
    ]);
    const { live, released } = liveLocalJj();
    const stack: AncestorStack = [
      { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "" },
      { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "" },
    ];

    const result = await bootstrapDependentBase(
      stack,
      localDeps(),
      bootstrapInput(originPath, "dep-run"),
      NO_PHASES,
      localBuilder(live),
    );

    expect(result.outcome).toBe("bootstrapped");
    if (result.outcome !== "bootstrapped") return;
    // The assembled head is a real 40-hex sha + tree (read from the LOCAL rev after rebase).
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.treeHash).toMatch(/^[0-9a-f]{40}$/u);
    // The run branch was created (handed back), and the LOCAL assembly bookmark is the
    // deterministic bootstrap name — NEVER a `tanren/integ|batch` host ref.
    expect(result.runBranch).toBe("dep-run");
    expect(result.localRef).toBe(bootstrapLocalIntegrationRef("dep-run"));
    expect(result.localRef.startsWith("tanren/integ")).toBe(false);
    expect(result.localRef.startsWith("tanren/batch")).toBe(false);
    // The per-ancestor divergence keys are the PRISTINE pre-integration remote heads — two
    // distinct shas (read from `<branch>@origin`, never advanced by the local rebase).
    expect(result.memberHeadShas["spec-a"]).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.memberHeadShas["spec-b"]).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.memberHeadShas["spec-a"]).not.toBe(result.memberHeadShas["spec-b"]);
    // The workspace stays OPEN for the writer loop — NOT released by the bootstrap.
    expect(released()).toBe(false);
    await result.release();
    expect(released()).toBe(true);
  });

  it("NEVER-DISCARD: the assembled head carries EVERY ancestor's content as its prefix + the run branch == that head", async () => {
    const { originPath } = makeAncestorFixture([
      { branch: "feat-a", file: "a.txt", contents: "a\n" },
      { branch: "feat-b", file: "b.txt", contents: "b\n" },
    ]);
    const { live } = liveLocalJj();
    const stack: AncestorStack = [
      { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "" },
      { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "" },
    ];

    const result = await bootstrapDependentBase(
      stack,
      localDeps(),
      bootstrapInput(originPath, "dep-run"),
      NO_PHASES,
      localBuilder(live),
    );
    expect(result.outcome).toBe("bootstrapped");
    if (result.outcome !== "bootstrapped") return;

    // NEVER-DISCARD (at bootstrap the dependent has no commits, so this is: the assembled
    // head = `main + ancestors`). Both ancestor files AND the base file are present at the
    // assembled head's tree — no ancestor work was dropped during the stack rebase.
    const tree = execFileSync("git", ["ls-tree", "--name-only", "-r", result.headSha], {
      cwd: live.workspacePath,
      env: gitEnv(),
      encoding: "utf8",
    });
    const files = tree.split("\n").filter(Boolean);
    expect(files).toContain("base.txt");
    expect(files).toContain("a.txt");
    expect(files).toContain("b.txt");
    // The dependent's run branch was created AT the assembled head: jj-native, the run
    // branch is a DISTINCT (empty) commit whose PARENT is the assembled head (the writer's
    // first commit lands on it) — so the run branch's parent == the assembled head, and the
    // run branch's TREE == the assembled head's tree (the empty commit carries the SAME
    // content, so every ancestor file is its history prefix — nothing discarded).
    expect(readSha(live.workspacePath, "dep-run~")).toBe(result.headSha);
    expect(readSha(live.workspacePath, "dep-run^{tree}")).toBe(result.treeHash);
    await result.release();
  });

  it("CONFLICT SURFACES: two ancestors editing the SAME file surface the conflict outcome + release the workspace", async () => {
    // Both ancestor branches edit `clash.txt` off `main` ⇒ a spec-vs-spec conflict when
    // the second is stacked onto the first.
    const { originPath } = makeAncestorFixture([
      { branch: "feat-a", file: "clash.txt", contents: "from-a\n" },
      { branch: "feat-b", file: "clash.txt", contents: "from-b\n" },
    ]);
    const { live, released } = liveLocalJj();
    const stack: AncestorStack = [
      { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "" },
      { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "" },
    ];

    const result = await bootstrapDependentBase(
      stack,
      localDeps(),
      bootstrapInput(originPath, "dep-run"),
      NO_PHASES,
      localBuilder(live),
    );

    // The SAME `conflict` outcome the batch path returns — the walker HOLDS the dependent +
    // routes the (spec-a, spec-b) pair to the resolver. NO run branch handed off.
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") return;
    expect(result.conflictBetween.specId).toBe("spec-b");
    expect(result.conflictBetween.otherSpecId).toBe("spec-a");
    // Nothing to hand off ⇒ the workspace was RELEASED (never a leaked runner).
    expect(released()).toBe(true);
  });

  it("CLEAN HEAD, NO HOST REF: a single-ancestor clean assembly materializes a head with no ref pushed to origin", async () => {
    const { originPath } = makeAncestorFixture([{ branch: "feat-a", file: "a.txt", contents: "a\n" }]);
    const { live } = liveLocalJj();
    const stack: AncestorStack = [{ specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "" }];

    const result = await bootstrapDependentBase(
      stack,
      localDeps(),
      bootstrapInput(originPath, "dep-run"),
      NO_PHASES,
      localBuilder(live),
    );
    expect(result.outcome).toBe("bootstrapped");
    if (result.outcome !== "bootstrapped") return;
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/u);

    // NO host ref written: the bare origin still holds ONLY `main` + the published ancestor
    // branch (`feat-a`) — neither the local assembly bookmark nor the run branch was pushed.
    const refs = execFileSync("git", ["ls-remote", "--heads", originPath], { env: gitEnv(), encoding: "utf8" });
    const remoteBranches = refs
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")[1]?.replace("refs/heads/", ""));
    expect(remoteBranches).toContain("main");
    expect(remoteBranches).toContain("feat-a");
    expect(remoteBranches).not.toContain("dep-run");
    expect(remoteBranches).not.toContain(bootstrapLocalIntegrationRef("dep-run"));
    await result.release();
  });
});
