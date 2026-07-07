// §3.2 LOCK (docs/roadmap/entity-analysis-layer.md): the deterministic ENTITY-MERGE
// FIRST-PASS over a REAL jj conflict + REAL `sem`. Proves the production seams end-to-end:
//
//   • a base-shift conflict where the dependent edits ONE entity (`alpha`) and the shifted
//     base edits a DIFFERENT, ADJACENT entity (`beta`) of the SAME file — git's line merge
//     can't separate them, so jj RECORDS a real conflict — is resolved DETERMINISTICALLY:
//     `buildSemEntityMergeFirstPass` reads the three conflict terms marker-free
//     (`jj file show -r <rev>`), entity-diffs base→ours / base→theirs via REAL `sem`, finds
//     the entity sets disjoint, and splices BOTH edits onto the base. The agent is NEVER
//     invoked; both edits land.
//   • a SAME-entity conflict (both sides edit `alpha`) DEFERS — `resolved:false` — so the
//     agent resolver path runs exactly as today (never a silent mis-merge).
//
// Driven against a REAL `jj` + REAL `sem` over a real multi-branch git fixture (the same
// substrate the base-shift realjj suites use). All git/jj routes through the scrubbed
// fixture env + the #506 GIT_DIR guard. SKIPS gracefully if `sem` is not on the host PATH
// (it is vendored on the runner image; a dev host may lack it) — graceful absence is itself
// the §3.2 contract.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JjWorkspaceVcsCore } from "../src/engine/providers/jjWorkspaceVcsCore.js";

// This suite spawns real `jj` + real `git` + real `sem` subprocesses per case. Under
// the 48-thread vitest pool the subprocess contention races the default 5s per-test
// timeout even though each op completes fine in isolation — silent flake in `just
// fast-check` / pre-push. Raise the ceiling for this file so the suite stays a
// reliable gate. Task #25.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { buildSemEntityMergeFirstPass } from "../src/engine/workflow/reviewMerge/conflictResolver/semEntityMerge.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./conformance/fakes/localCommandSubstrate.js";
import { assertGitDirUnder, fixtureGitEnv } from "./conformance/fakes/fixtureGitEnv.js";

function gitEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv(process.env);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "inherit"] }).toString();
}

// Detect the REAL entity-diff `sem` (Ataraxy Labs) on the host. `sem` is vendored on the
// RUNNER image, NOT on the CI host that runs `just test` — so this realjj+real-sem case must
// SKIP when it is absent (the §3.1-producer realjj test skips the same way; graceful absence
// IS the §3.2 contract — the UNIT suite with fakes validates the logic in CI either way).
//
// We don't trust `sem --version` alone: a DIFFERENT `sem` binary may sit on PATH and answer
// `--version` (a false positive that made #529's CI fail). Instead we FUNCTIONALLY probe the
// entity differ — feed `sem diff --stdin --json` a trivial one-entity FileChange and confirm
// it returns the entity-diff envelope (a `changes` array). Only the real entity `sem` does.
function hasSem(): boolean {
  try {
    const probe = JSON.stringify([
      {
        filePath: "probe.js",
        status: "modified",
        beforeContent: "function p() { return 1; }\n",
        afterContent: "function p() { return 2; }\n",
      },
    ]);
    const out = execFileSync("sem", ["diff", "--stdin", "--json"], {
      input: probe,
      stdio: ["pipe", "pipe", "ignore"],
    }).toString();
    const parsed = JSON.parse(out) as { changes?: unknown };
    return Array.isArray(parsed.changes);
  } catch {
    return false;
  }
}

const TIMEOUT_MS = 60_000;

// base.js carries two ADJACENT one-line functions, so an edit to EITHER, on two branches,
// collides as ONE git/jj conflict block (git can't isolate adjacent-line edits) even though
// the edits are to DIFFERENT entities. `theirs` (the shifted base, on main) edits `beta`.
const BASE_SRC = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
const MAIN_SHIFT_SRC = "function alpha() { return 1; }\nfunction beta() { return 222; }\n";

/**
 * A real bare git origin: `main` advanced to edit `beta` (the shifted base = "theirs"), and a
 * dependent `feat-dep` (off the ORIGINAL base) that edits `alpha` (= "ours"). When `feat-dep`
 * rebases onto the advanced `main`, jj records a real conflict on the adjacent functions.
 * `depSrc` lets a same-entity variant edit `alpha` on BOTH sides.
 */
function makeFixture(depSrc: string): { originPath: string } {
  const root = mkdtempSync(join(tmpdir(), "tanren-entity-merge-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
  assertGitDirUnder(work, root, gitEnv());
  writeFileSync(join(work, "base.js"), BASE_SRC);
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);

  // feat-dep off the ORIGINAL base (edits its entity); then main advances (edits beta).
  git(work, ["checkout", "--quiet", "-b", "feat-dep"]);
  writeFileSync(join(work, "base.js"), depSrc);
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "feat-dep work"]);

  git(work, ["checkout", "--quiet", "main"]);
  writeFileSync(join(work, "base.js"), MAIN_SHIFT_SRC);
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "main shifts (edits beta)"]);

  git(work, ["clone", "--quiet", "--bare", work, originPath]);
  return { originPath };
}

/**
 * Mirror the §3.2 production path: open a live jj workspace on `main`, track `feat-dep`,
 * rebase it onto `main@origin` (jj RECORDS the conflict), then run the entity-merge
 * first-pass over the SAME workspace (theirs = `main@origin`, ours = `feat-dep@origin`).
 * Returns the first-pass outcome.
 */
async function runFirstPassOverRealConflict(
  originPath: string,
): Promise<Awaited<ReturnType<ReturnType<typeof buildSemEntityMergeFirstPass>["attempt"]>>> {
  const ssh = new LocalCommandSubstrate();
  const scratch = mkdtempSync(join(tmpdir(), "tanren-entity-merge-ws-"));
  const workspacePath = join(scratch, "ws");
  const core = new JjWorkspaceVcsCore({ substrate: ssh, target: LOCAL_HANDLE, timeoutMs: TIMEOUT_MS });

  const workspace = await core.openWorkspace({ repoUrl: originPath, baseBranch: "main", path: workspacePath });
  // Track the dependent's published head + allow rewriting the immutable published commit
  // (the SAME prep the live applier does before a rebase of a published head).
  await ssh.run(LOCAL_HANDLE, {
    cwd: workspacePath,
    timeoutMs: TIMEOUT_MS,
    command: [
      "set -eu",
      "jj bookmark track feat-dep --remote origin",
      `jj config set --repo 'revset-aliases."immutable_heads()"' 'none()'`,
    ].join(" && "),
  });
  // Rebase feat-dep onto the shifted base — jj records the conflict IN the commit (never throws).
  const rebase = await core.rebaseOnto(workspace, "feat-dep", "main@origin");
  expect(rebase.outcome).toBe("conflicted");
  const conflictedPaths = rebase.conflict?.paths ?? [];
  expect(conflictedPaths).toContain("base.js");

  // The §3.2 first-pass over the SAME workspace: theirs = main@origin (the rebase dest),
  // ours = feat-dep@origin (the dependent's PRE-rebase head, untouched by the local rebase).
  const firstPass = buildSemEntityMergeFirstPass(
    { ssh, target: LOCAL_HANDLE, workspacePath, timeoutMs: TIMEOUT_MS },
    { oursRev: "feat-dep@origin", theirsRev: "main@origin" },
  );
  return firstPass.attempt({ conflictedPaths });
}

describe.runIf(hasSem())("§3.2 entity-merge first-pass over a REAL jj conflict + REAL sem", () => {
  it("a DIFFERENT-entity conflict is resolved DETERMINISTICALLY — both edits land, no agent", async () => {
    // ours edits `alpha`; theirs edits `beta` — different adjacent entities.
    const { originPath } = makeFixture("function alpha() { return 111; }\nfunction beta() { return 2; }\n");
    const out = await runFirstPassOverRealConflict(originPath);

    expect(out.resolved).toBe(true);
    if (!out.resolved) return;
    const merged = out.files.find((f) => f.path === "base.js");
    expect(merged).toBeDefined();
    // BOTH edits land deterministically: alpha=111 (ours) AND beta=222 (theirs), no markers.
    expect(merged?.content).toContain("return 111;");
    expect(merged?.content).toContain("return 222;");
    expect(merged?.content).not.toContain("<<<<<<<");
    expect(out.entityIds.length).toBeGreaterThanOrEqual(2);
  });

  it("a SAME-entity conflict DEFERS to the agent (resolved:false) — never a silent mis-merge", async () => {
    // BOTH sides edit `alpha` — a genuine same-entity conflict; the first-pass must defer.
    const { originPath } = makeSameEntityFixture();
    const out = await runFirstPassOverRealConflict(originPath);
    expect(out.resolved).toBe(false);
    if (out.resolved) return;
    expect(out.reason).toContain("same entity");
  });
});

/** A fixture where BOTH `feat-dep` and the shifted `main` edit `alpha` (a same-entity conflict). */
function makeSameEntityFixture(): { originPath: string } {
  const root = mkdtempSync(join(tmpdir(), "tanren-entity-merge-same-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "--quiet", "--initial-branch=main"]);
  assertGitDirUnder(work, root, gitEnv());
  writeFileSync(join(work, "base.js"), BASE_SRC);
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);
  git(work, ["checkout", "--quiet", "-b", "feat-dep"]);
  writeFileSync(join(work, "base.js"), "function alpha() { return 111; }\nfunction beta() { return 2; }\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "feat-dep edits alpha"]);
  git(work, ["checkout", "--quiet", "main"]);
  writeFileSync(join(work, "base.js"), "function alpha() { return 999; }\nfunction beta() { return 2; }\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "main also edits alpha"]);
  git(work, ["clone", "--quiet", "--bare", work, originPath]);
  return { originPath };
}
