// Behavior tests for the jj-backed conflict applier (tanren-owns-the-engine.md §2/§5,
// Wave-3/S1) over a REAL jj process + a real local git fixture in a temp dir — NOT a
// scripted echo. They prove the §5-P1 fail-open closure + the jj first-class-conflict
// contract the applier consumes:
//   - gather() rebases the PR head onto the advanced base; jj RECORDS the conflict and
//     the conflicted file's markers are read back for the Answerer;
//   - applyResolution() writes the resolution INTO the commit; exportCleanGitRef (in
//     publishResolved) then SUCCEEDS and the resolution is pushed to the bare origin;
//   - a STILL-CONFLICTED publish is REFUSED (exportCleanGitRef throws — the fail-closed
//     §2 host boundary);
//   - FAIL-CLOSED: an infra failure in gather() (an unreachable clone source) is a LOUD
//     throw, never a `|| true` → empty-conflict that false-cleans a merge (the §5-P1 fix).
//
// cwd-isolation discipline: the LocalCommandSubstrate anchors cwd to the temp workspace
// and the fixture lives entirely under mkdtemp — a prior fixture corrupted the host repo
// by letting jj run in process.cwd(), so every command here carries an explicit temp cwd.

import { describe, expect, it } from "vitest";
import { JjWorkspaceVcsCore } from "../src/engine/providers/jjWorkspaceVcsCore.js";
import { JjWorkspaceConflictApplier } from "../src/engine/workflow/reviewMerge/conflictResolver/jjWorkspaceApplier.js";
import type { JjConflictApplierDeps } from "../src/engine/workflow/reviewMerge/conflictResolver/jjWorkspaceApplier.js";
import type { SecretStore } from "../src/engine/contracts/secretStore.js";
import type { VcsProvider } from "../src/engine/contracts/vcsProvider.js";
import { execFileSync } from "node:child_process";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./conformance/fakes/localCommandSubstrate.js";
import { makeJjApplierFixture } from "./conformance/fakes/jjConflictApplierFixtureRepo.js";
import { fixtureGitEnv } from "./conformance/fakes/fixtureGitEnv.js";

// The anonymous push path (no installation + empty credentialRef) NEVER calls
// resolveToken — a stub that throws proves it. Cast: the applier only ever touches
// resolveToken on the authed path, exercised by the live apex run, not here.
const noTokenVcsProvider = {
  resolveToken: () => {
    throw new Error("resolveToken must NOT be called on the anonymous push path");
  },
} as unknown as VcsProvider;

const emptySecrets: SecretStore = {
  async get() {},
  put: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  list: () => Promise.resolve([]),
};

const TIMEOUT_MS = 60_000;

// jj at ~/.local/bin/jj; the conformance suite proves it is present. Each test owns its
// own fixture temp dir + workspace, released by the fixture's mkdtemp (no shared state).
function buildApplier(opts: { conflicting: boolean; releaseLog: string[] }): {
  applier: JjWorkspaceConflictApplier;
  originPath: string;
} {
  const fixture = makeJjApplierFixture({ conflicting: opts.conflicting });
  return {
    applier: applierOver(fixture.originPath, fixture.workspacePath, opts.releaseLog),
    originPath: fixture.originPath,
  };
}

function applierOver(repoUrl: string, workspacePath: string, releaseLog: string[]): JjWorkspaceConflictApplier {
  const core = new JjWorkspaceVcsCore({
    substrate: new LocalCommandSubstrate(),
    target: LOCAL_HANDLE,
    timeoutMs: TIMEOUT_MS,
    // identity resolver: the test passes the real fixture origin + `main@origin` verbatim.
  });
  const deps: JjConflictApplierDeps = {
    core,
    target: LOCAL_HANDLE,
    workspacePath,
    ssh: new LocalCommandSubstrate(),
    secrets: emptySecrets,
    vcsProvider: noTokenVcsProvider,
    facts: {
      repoUrl,
      baseBranch: "main",
      baseRevision: "main@origin",
      headBranch: "feature",
      githubCredentialRef: "",
    },
    timeoutMs: TIMEOUT_MS,
    release: async () => {
      releaseLog.push("released");
    },
  };
  return new JjWorkspaceConflictApplier(deps);
}

describe("JjWorkspaceConflictApplier (real jj)", () => {
  it("gather RECORDS the rebase conflict and reads the conflicted file's markers", async () => {
    const releaseLog: string[] = [];
    const { applier } = buildApplier({ conflicting: true, releaseLog });

    const gathered = await applier.gather();

    expect(gathered.files.map((f) => f.path)).toEqual(["src/conflicted.ts"]);
    // jj materialized its own conflict markers in the working copy — the Answerer reads them.
    expect(gathered.files[0]?.conflictedContent).toMatch(/<<<<<<<|conflict/u);
  });

  it("applyResolution + publishResolved produce a clean exportable ref and push it", async () => {
    const releaseLog: string[] = [];
    const { applier, originPath } = buildApplier({ conflicting: true, releaseLog });

    await applier.gather();
    await applier.applyResolution([{ path: "src/conflicted.ts", content: "resolved\n" }]);
    // publishResolved exports (REFUSES a conflicted ref — clean here) + pushes + releases.
    await applier.publishResolved();

    // The resolution landed on the bare origin's feature branch.
    // Scrub the git repo-selecting vars (GIT_DIR/GIT_WORK_TREE/…) so a leaked ambient one can
    // never override the explicit `--git-dir` and redirect this read onto the host worktree.
    const onOrigin = execFileSync("git", ["--git-dir", originPath, "show", "feature:src/conflicted.ts"], {
      env: fixtureGitEnv(process.env),
      encoding: "utf8",
    });
    expect(onOrigin).toBe("resolved\n");
    expect(releaseLog).toEqual(["released"]);
  });

  it("publishResolved REFUSES a still-conflicted head (exportCleanGitRef throws) — fail-closed", async () => {
    const releaseLog: string[] = [];
    const { applier } = buildApplier({ conflicting: true, releaseLog });

    await applier.gather();
    // No applyResolution — the head is STILL conflicted. publishResolved must refuse to
    // export it (a conflicted ref is NEVER pushed to the host).
    await expect(applier.publishResolved()).rejects.toThrow(/conflict|refusing|unresolved/iu);
  });

  it("FAIL-CLOSED (§5-P1): an infra failure in gather() is a LOUD throw, not an empty conflict", async () => {
    const releaseLog: string[] = [];
    // Point the applier at a NON-EXISTENT clone source — the old git applier's
    // `git fetch || true` would have swallowed this into an empty conflict set that
    // false-cleans the merge. The jj applier MUST throw loudly instead.
    const applier = applierOver("/tmp/tanren-nonexistent-origin.git", "/tmp/tanren-jjapplier-noexist-ws", releaseLog);

    await expect(applier.gather()).rejects.toThrow(/.+/u);
  });

  it("abort releases the workspace without discarding work (no host-side merge to unwind)", async () => {
    const releaseLog: string[] = [];
    const { applier } = buildApplier({ conflicting: true, releaseLog });

    await applier.gather();
    await applier.abort();

    expect(releaseLog).toEqual(["released"]);
  });
});
