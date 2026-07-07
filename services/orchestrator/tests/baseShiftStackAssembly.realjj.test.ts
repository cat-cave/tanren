// WS-A PR-6 LOCK (walker-jj-local-integration-design.md §2.2): a never-discard base shift
// over the LOCAL ancestor stack. The opener ASSEMBLES the re-resolved stack (`main + ordered
// ancestors`) LOCALLY — NO orchestrator-synthesized `tanren/integ` host ref — and the
// coordinator REBASES the dependent's OWN published head onto the assembled stack head IN
// PLACE (never-discard: the dependent's commit survives the rebase). Driven against a REAL
// `jj` process (the LocalCommandSubstrate) over a real multi-branch git fixture — the SAME
// `integrateOverWorkspace` assembly + `core.rebaseOnto` the live opener (`assembleBaseShift
// StackWorkspace`) + the `BaseShiftCoordinator` run, with the runner-alloc seam swapped for
// the local substrate (the alloc is conformance-pinned elsewhere).
//
// Proves: (1) a TWO-ancestor stack assembles CLEAN locally + the dependent rebases onto the
// assembled head, KEEPING its own commit (never-discard); (2) a MERGED ancestor DROPPED from
// the re-resolved stack is absent from the assembled base (the dependent rebases onto the
// SMALLER stack). All git/jj routes through the scrubbed fixture env + the #506 GIT_DIR guard.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LiveJjWorkspace } from "../src/engine/providers/liveJjWorkspace.js";

// This suite spawns real `jj` + real `git` subprocesses per case. Under the 48-thread
// vitest pool the subprocess contention races the default 5s per-test timeout even
// though each op completes fine in isolation — silent flake in `just fast-check` /
// pre-push. Raise the ceiling for this file so the suite stays a reliable gate. Task #25.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { JjWorkspaceVcsCore } from "../src/engine/providers/jjWorkspaceVcsCore.js";
import { integrateOverWorkspace } from "../src/engine/dag/jjLocalIntegration.js";
import { baseShiftStackLocalRef } from "../src/engine/dag/baseShiftStackAssembly.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./conformance/fakes/localCommandSubstrate.js";
import { assertGitDirUnder, fixtureGitEnv } from "./conformance/fakes/fixtureGitEnv.js";

// The git env every fixture child runs under: the deterministic Fixture author PLUS the git
// repo-selecting vars (GIT_DIR/GIT_WORK_TREE/…) SCRUBBED, so a leaked one can never redirect a
// `cwd`-scoped git op onto the host worktree (the live branch-corruption vector). Read from
// `process.env` at CALL time. (jj children are scrubbed by LocalCommandSubstrate.)
function gitEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv(process.env);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "inherit"] }).toString();
}

/**
 * A real bare git origin: `main`, two ancestor PR-head branches (`feat-a`, `feat-b`, each off
 * `main` editing a DISTINCT file → they stack clean), and the DEPENDENT's published head
 * `feat-dep` (off `main`, editing its OWN file → it rebases clean onto the assembled stack).
 */
function makeStackFixture(): { originPath: string; depHeadSha: string } {
  const root = mkdtempSync(join(tmpdir(), "tanren-base-shift-stack-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
  // #506 GUARD: prove `git init` selected the temp seed dir — not a leaked GIT_DIR / the host
  // worktree's real `.git` — BEFORE any commit can land on the worktree's branch.
  assertGitDirUnder(work, root, gitEnv());
  writeFileSync(join(work, "base.txt"), "base\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);

  for (const [branch, file] of [
    ["feat-a", "a.txt"],
    ["feat-b", "b.txt"],
    ["feat-dep", "dep.txt"],
  ] as const) {
    git(work, ["checkout", "--quiet", "main"]);
    git(work, ["checkout", "--quiet", "-b", branch]);
    writeFileSync(join(work, file), `${branch}\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "-m", `${branch} work`]);
  }
  const depHeadSha = git(work, ["rev-parse", "feat-dep"]).trim();
  git(work, ["checkout", "--quiet", "main"]);
  git(work, ["clone", "--quiet", "--bare", work, originPath]);
  return { originPath, depHeadSha };
}

/** A LiveJjWorkspace over the REAL jj CLI on the local substrate (anonymous clone of a local fixture). */
function liveLocalJj(): LiveJjWorkspace {
  const scratch = mkdtempSync(join(tmpdir(), "tanren-base-shift-stack-ws-"));
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

/**
 * Mirror `assembleBaseShiftStackWorkspace` over the LOCAL substrate (the runner-alloc seam
 * swapped out): stack the ancestor members onto `main` via `integrateOverWorkspace`, then
 * prepare the dependent's published head + rebase it onto the assembled stack head. Returns
 * the assembled head sha + the rebased dependent head sha + the open workspace's tree files.
 */
async function baseShiftOverStack(
  originPath: string,
  ancestorBranches: string[],
): Promise<{ assembledHeadSha: string; rebasedDepHeadSha: string; treeFiles: string[] }> {
  const live = liveLocalJj();
  const ssh = new LocalCommandSubstrate();
  const localRef = baseShiftStackLocalRef("feat-dep");
  const integration = await integrateOverWorkspace(live, ssh, {
    baseBranch: "main",
    repoUrl: originPath,
    members: ancestorBranches.map((branch, i) => ({ specId: `spec-${i}`, branch })),
    localRef,
    timeoutMs: 60_000,
  });
  expect(integration.outcome).toBe("integrated");
  if (integration.outcome !== "integrated") throw new Error("assembly conflicted");
  const ws = integration.workspace;
  if (ws === undefined) throw new Error("no open workspace handle");

  // Prepare the dependent's OWN published head for an in-place rebase onto the assembled head
  // (the SAME track + immutable-heads prep `assembleBaseShiftStackWorkspace` runs for the head
  // branch — the member bookmarks were already prepped by `integrateOverWorkspace`).
  await ssh.run(LOCAL_HANDLE, {
    command: [
      "set -eu",
      "jj bookmark track feat-dep --remote origin",
      `jj config set --repo 'revset-aliases."immutable_heads()"' 'none()'`,
    ].join(" && "),
    cwd: live.workspacePath,
    timeoutMs: 60_000,
  });
  // The coordinator's rebaseOnto: rebase the dependent's branch onto the ASSEMBLED stack head
  // (a real sha — NOT `${newBaseRef}@origin`). never-discard: the same branch, rebased.
  const rebase = await live.core.rebaseOnto(ws, "feat-dep", integration.headSha);
  expect(rebase.outcome).toBe("clean");
  // The rebased dependent head's tree (read via the colocated git) — proves what content the
  // dependent now sits on (the assembled stack + its own commit).
  const treeFiles = git(live.workspacePath, ["ls-tree", "-r", "--name-only", rebase.headSha])
    .trim()
    .split("\n")
    .filter((f) => f !== "");
  return { assembledHeadSha: integration.headSha, rebasedDepHeadSha: rebase.headSha, treeFiles };
}

describe("WS-A PR-6 — never-discard base shift over the LOCAL ancestor stack (real jj)", () => {
  it("a TWO-ancestor stack assembles locally + the dependent rebases onto it, KEEPING its own commit", async () => {
    const { originPath, depHeadSha } = makeStackFixture();
    const { assembledHeadSha, rebasedDepHeadSha, treeFiles } = await baseShiftOverStack(originPath, [
      "feat-a",
      "feat-b",
    ]);

    // The assembled stack head is a real 40-hex sha (the locally-stacked `main + a + b`),
    // NOT a synthesized host ref — and the rebase rewrote the dependent onto it (a NEW sha).
    expect(assembledHeadSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(rebasedDepHeadSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(rebasedDepHeadSha).not.toBe(depHeadSha);
    // NEVER-DISCARD: the dependent's OWN file survives the rebase, AND both ancestors' files
    // are present (the dependent now sits on `main + a + b + dep`) — the work was rebased in
    // place, not regenerated/discarded.
    expect(treeFiles).toEqual(expect.arrayContaining(["base.txt", "a.txt", "b.txt", "dep.txt"]));
  });

  it("a MERGED ancestor DROPPED from the re-resolved stack is absent from the assembled base", async () => {
    const { originPath } = makeStackFixture();
    // The re-resolved stack drops `feat-b` (its ancestor merged): the dependent rebases onto
    // `main + a` only — `b.txt` MUST NOT appear in its tree.
    const { treeFiles } = await baseShiftOverStack(originPath, ["feat-a"]);
    expect(treeFiles).toEqual(expect.arrayContaining(["base.txt", "a.txt", "dep.txt"]));
    expect(treeFiles).not.toContain("b.txt");
  });
});
