// REGRESSION (apex v94 `speculative_assembly` halt): the base-shift / conflict-resolve prep
// that makes a dependent's PUBLISHED head a resolvable LOCAL bookmark for an in-place rebase
// used a BARE `jj bookmark track <head> --remote origin`. `jj bookmark track` matches <head>
// as a GLOB PATTERN, so when `<head>@origin` is ABSENT from the workspace (the base-shift
// clone predated the dependent's head being fetchable — a real race), the track matches ZERO
// bookmarks and EXITS 0: a SILENT NO-OP that leaves no local `<head>`, so the later
// `jj rebase -b <head>` fails `Revision <head> doesn't exist` and the run re-drives to the
// convergence cap — EVEN THOUGH the head branch exists on the forge.
//
// `trackPublishedHeadCommands` closes it: FETCH the head (repair the race) → track → ASSERT
// it resolves (fail-closed on a genuinely-missing head). This suite drives the FIX against a
// REAL `jj` process over the LocalCommandSubstrate + the real `JjWorkspaceVcsCore` clone —
// FIRST documenting the bare-track silent no-op, then proving the helper repairs the race and
// FAILS LOUD on a truly-absent head. Mirrors `baseShiftStackAssembly.realjj.test.ts`.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Real `jj` + `git` subprocesses per case; raise the ceiling like the sibling real-jj suite
// so subprocess contention under the vitest pool never flakes the default 5s timeout.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { JjWorkspaceVcsCore } from "../src/engine/providers/jjWorkspaceVcsCore.js";
import { trackPublishedHeadCommands } from "../src/engine/providers/jjPublishedHead.js";
import type { CommandResult } from "../src/engine/contracts/commandSubstrate.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./conformance/fakes/localCommandSubstrate.js";
import { assertGitDirUnder, fixtureGitEnv } from "./conformance/fakes/fixtureGitEnv.js";

// The git repo-selecting vars (GIT_DIR/GIT_WORK_TREE/…) scrubbed, so a leaked one can never
// redirect a `cwd`-scoped git op onto the host worktree (the live branch-corruption vector).
function gitEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv(process.env);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "inherit"] }).toString();
}

/**
 * A bare git origin holding ONLY `main` (NO head branch yet), plus its seed worktree so the
 * test can PUSH the dependent head AFTER the clone — reproducing the "head not in the initial
 * clone" race that the bare track silently no-ops on.
 */
function makeMainOnlyOrigin(): { originPath: string; seedWork: string } {
  const root = mkdtempSync(join(tmpdir(), "tanren-track-head-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
  // #506 GUARD: prove `git init` selected the temp seed dir, not a leaked GIT_DIR / the host .git.
  assertGitDirUnder(work, root, gitEnv());
  writeFileSync(join(work, "base.txt"), "base\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);
  git(work, ["clone", "--quiet", "--bare", work, originPath]);
  git(work, ["remote", "add", "origin", originPath]);
  return { originPath, seedWork: work };
}

/** Push a NEW head branch `feat-dep` (off main, its own file) to origin — AFTER the clone. */
function publishDepHead(seedWork: string): string {
  git(seedWork, ["checkout", "--quiet", "-b", "feat-dep"]);
  writeFileSync(join(seedWork, "dep.txt"), "dep\n");
  git(seedWork, ["add", "-A"]);
  git(seedWork, ["commit", "--quiet", "-m", "feat-dep work"]);
  git(seedWork, ["push", "--quiet", "origin", "feat-dep"]);
  return git(seedWork, ["rev-parse", "feat-dep"]).trim();
}

/** Clone `originPath` via the REAL `JjWorkspaceVcsCore.openWorkspace` (all-branch clone of what exists NOW). */
async function openWorkspaceOn(originPath: string): Promise<{ substrate: LocalCommandSubstrate; wsPath: string }> {
  const substrate = new LocalCommandSubstrate();
  const core = new JjWorkspaceVcsCore({ substrate, target: LOCAL_HANDLE, timeoutMs: 60_000 });
  const wsPath = join(mkdtempSync(join(tmpdir(), "tanren-track-head-ws-")), "ws");
  await core.openWorkspace({ repoUrl: originPath, baseBranch: "main", path: wsPath });
  return { substrate, wsPath };
}

/** Run a shell command over the local substrate in `wsPath` and return the raw result. */
async function sh(substrate: LocalCommandSubstrate, wsPath: string, command: string): Promise<CommandResult> {
  return substrate.run(LOCAL_HANDLE, { command, cwd: wsPath, timeoutMs: 60_000 });
}

/** Does the local bookmark `<name>` resolve to a commit in this workspace? */
async function resolves(substrate: LocalCommandSubstrate, wsPath: string, name: string): Promise<CommandResult> {
  return sh(substrate, wsPath, `jj log -r ${JSON.stringify(name)} --no-graph -T 'commit_id'`);
}

describe("base-shift published-head track — silent-no-op fix (real jj)", () => {
  it("bare track SILENTLY NO-OPS on a head absent from the clone; the helper FETCHES + resolves it", async () => {
    const { originPath, seedWork } = makeMainOnlyOrigin();
    const { substrate, wsPath } = await openWorkspaceOn(originPath);
    // The head branch is published to the forge AFTER the clone (the race): the workspace's
    // clone captured only `main`, so `feat-dep@origin` is NOT present.
    const depSha = publishDepHead(seedWork);

    // DOCUMENT THE BUG: the bare track matches ZERO bookmarks (glob no-match) → exit 0, and no
    // local `feat-dep` is created, so the rebase target silently does not resolve.
    const bareTrack = await sh(substrate, wsPath, "jj bookmark track 'feat-dep' --remote origin");
    // Silent success (exit 0)…
    expect(bareTrack.exitCode).toBe(0);
    const afterBare = await resolves(substrate, wsPath, "feat-dep");
    // …but the local bookmark was never created — the rebase target does not resolve.
    expect(afterBare.exitCode).not.toBe(0);

    // THE FIX: fetch (repair the race) → track → assert. The chain succeeds and `feat-dep` now
    // resolves to the PUSHED head sha — the rebase `-b feat-dep` target exists.
    const fixed = await sh(substrate, wsPath, ["set -eu", ...trackPublishedHeadCommands("feat-dep")].join(" && "));
    expect(fixed.exitCode).toBe(0);
    const afterFix = await resolves(substrate, wsPath, "feat-dep");
    expect(afterFix.exitCode).toBe(0);
    expect(afterFix.stdout.trim()).toBe(depSha);
  });

  it("FAILS LOUD (fail-closed) on a genuinely-missing head instead of silently continuing", async () => {
    const { originPath } = makeMainOnlyOrigin();
    const { substrate, wsPath } = await openWorkspaceOn(originPath);

    // `feat-missing` was NEVER published to the forge. The fetch is a no-match warning (exit 0),
    // so the post-track ASSERT is what fails the `set -eu` chain LOUDLY — the run HOLDS rather
    // than proceeding to a rebase with a silently-missing target.
    const chain = await sh(substrate, wsPath, ["set -eu", ...trackPublishedHeadCommands("feat-missing")].join(" && "));
    expect(chain.exitCode).not.toBe(0);
    const afterChain = await resolves(substrate, wsPath, "feat-missing");
    expect(afterChain.exitCode).not.toBe(0);
  });
});
