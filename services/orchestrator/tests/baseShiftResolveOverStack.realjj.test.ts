// WS-A PR-6b LOCK (walker-jj-local-integration-design.md §2.2): a never-discard base-shift
// CONFLICT RESOLVE over the LOCAL ancestor stack. PR-6 converted the base-shift OPENER to the
// jj-local multi-ref assembly but LEFT the conflict RESOLVER cloning the synthesized
// `tanren/integ` ref as a SINGLE host ref. This proves the resolver's jj-local path: ASSEMBLE
// `main + ordered ancestors` LOCALLY (the SAME `integrateOverWorkspace` the opener uses) and
// gather + resolve the recorded conflict against the LOCALLY-ASSEMBLED stack head — handing the
// `JjWorkspaceConflictApplier` the OPEN assembled workspace (`preOpenedWorkspace`) + the assembled
// head SHA as the rebase base, so NO `${shiftedBase}@origin` clone happens.
//
// Driven against a REAL `jj` process over a real multi-branch git fixture (the same substrate the
// assembly + applier suites use). Proves: (1) a dependent that CONFLICTS with an ancestor resolves
// IN PLACE against the assembled stack head — the resolution lands on the dependent's branch and
// SITS ON the assembled stack (the other ancestor's file is present), never-discard; (2) the base
// the conflict is gathered against is the LOCAL assembled head sha (a real 40-hex commit), NOT a
// synthesized `tanren/integ` host ref. All git/jj routes through the scrubbed fixture env + #506 guard.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveJjWorkspace } from "../src/engine/providers/liveJjWorkspace.js";
import type { SecretStore } from "../src/engine/contracts/secretStore.js";
import type { VcsProvider } from "../src/engine/contracts/vcsProvider.js";
import { JjWorkspaceVcsCore } from "../src/engine/providers/jjWorkspaceVcsCore.js";
import { integrateOverWorkspace } from "../src/engine/dag/jjLocalIntegration.js";
import { baseShiftStackLocalRef } from "../src/engine/dag/baseShiftStackAssembly.js";
import { JjWorkspaceConflictApplier } from "../src/engine/workflow/reviewMerge/conflictResolver/jjWorkspaceApplier.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./conformance/fakes/localCommandSubstrate.js";
import { assertGitDirUnder, fixtureGitEnv } from "./conformance/fakes/fixtureGitEnv.js";

// The git env every fixture child runs under: the deterministic Fixture author PLUS the git
// repo-selecting vars (GIT_DIR/GIT_WORK_TREE/…) SCRUBBED, so a leaked one can never redirect a
// `cwd`-scoped git op onto the host worktree (the live branch-corruption vector). Read at CALL time.
function gitEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv(process.env);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "inherit"] }).toString();
}

// The anonymous push path (no installation + empty credentialRef) NEVER calls resolveToken.
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

/**
 * A real bare git origin: `main`, an ancestor PR-head `feat-a` (edits `shared.txt`), a SECOND
 * ancestor `feat-b` (edits its OWN `b.txt` → stacks clean), and the DEPENDENT `feat-dep` (also
 * edits `shared.txt` off `main` → it CONFLICTS with `feat-a` when rebased onto the assembled stack).
 */
function makeConflictingStackFixture(): { originPath: string } {
  const root = mkdtempSync(join(tmpdir(), "tanren-base-shift-resolve-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
  // #506 GUARD: prove `git init` selected the temp seed dir — not a leaked GIT_DIR / the host
  // worktree's real `.git` — BEFORE any commit can land on the worktree's branch.
  assertGitDirUnder(work, root, gitEnv());
  writeFileSync(join(work, "base.txt"), "base\n");
  writeFileSync(join(work, "shared.txt"), "base-shared\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);

  // feat-a + feat-dep BOTH edit shared.txt (a real conflict); feat-b edits its own file.
  for (const [branch, file, content] of [
    ["feat-a", "shared.txt", "from-a\n"],
    ["feat-b", "b.txt", "from-b\n"],
    ["feat-dep", "shared.txt", "from-dep\n"],
  ] as const) {
    git(work, ["checkout", "--quiet", "main"]);
    git(work, ["checkout", "--quiet", "-b", branch]);
    writeFileSync(join(work, file), content);
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "-m", `${branch} work`]);
  }
  git(work, ["checkout", "--quiet", "main"]);
  git(work, ["clone", "--quiet", "--bare", work, originPath]);
  return { originPath };
}

/** A LiveJjWorkspace over the REAL jj CLI on the local substrate (anonymous clone of a local fixture). */
function liveLocalJj(): LiveJjWorkspace {
  const scratch = mkdtempSync(join(tmpdir(), "tanren-base-shift-resolve-ws-"));
  const core = new JjWorkspaceVcsCore({
    substrate: new LocalCommandSubstrate(),
    target: LOCAL_HANDLE,
    timeoutMs: TIMEOUT_MS,
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
 * Mirror the resolver's jj-local path (`baseShiftLiveResolve.prepareResolveWorkspace` + the applier
 * with `preOpenedWorkspace`): ASSEMBLE `main + ordered ancestors` LOCALLY via `integrateOverWorkspace`,
 * then hand the `JjWorkspaceConflictApplier` the OPEN workspace + the assembled head SHA as the rebase
 * base and run gather → applyResolution → publishResolved. Returns the assembled head sha + the files
 * present on the dependent's resolved head (read off the bare origin after the resolution push).
 */
async function resolveOverAssembledStack(
  originPath: string,
  ancestorBranches: string[],
  resolution: { path: string; content: string },
): Promise<{ assembledHeadSha: string; originFiles: string[] }> {
  const live = liveLocalJj();
  const ssh = new LocalCommandSubstrate();
  const localRef = baseShiftStackLocalRef("feat-dep");
  // (1) ASSEMBLE the re-resolved stack LOCALLY — the SAME `assembleBaseShiftStackLive` the
  // resolver runs. The workspace stays OPEN with the integration bookmark at the assembled head.
  const integration = await integrateOverWorkspace(live, ssh, {
    baseBranch: "main",
    repoUrl: originPath,
    members: ancestorBranches.map((branch, i) => ({ specId: `spec-${i}`, branch })),
    localRef,
    timeoutMs: TIMEOUT_MS,
  });
  expect(integration.outcome).toBe("integrated");
  if (integration.outcome !== "integrated") throw new Error("assembly conflicted");
  const ws = integration.workspace;
  if (ws === undefined) throw new Error("no open workspace handle");
  // The assembled head is a real 40-hex commit — NOT a `tanren/integ` host ref.
  expect(integration.headSha).toMatch(/^[0-9a-f]{40}$/u);

  // (2) RESOLVE the dependent's recorded conflict against the LOCAL assembled head — the applier
  // gathers over the ALREADY-OPEN assembled workspace (`preOpenedWorkspace`, no re-clone) and
  // rebases the dependent's head onto the assembled head SHA (`baseRevision`), NOT `${ref}@origin`.
  const applier = new JjWorkspaceConflictApplier({
    core: live.core,
    target: live.target,
    workspacePath: live.workspacePath,
    ssh,
    secrets: emptySecrets,
    vcsProvider: noTokenVcsProvider,
    facts: {
      repoUrl: originPath,
      baseBranch: "main",
      baseRevision: integration.headSha,
      headBranch: "feat-dep",
      githubCredentialRef: "",
    },
    timeoutMs: TIMEOUT_MS,
    preOpenedWorkspace: ws,
    release: async () => {},
  });
  const gathered = await applier.gather();
  // The dependent CONFLICTS with feat-a on shared.txt — gather recorded it (the rebase target was
  // the assembled head, so the conflict is against the ASSEMBLED stack, not a single ref).
  expect(gathered.files.map((f) => f.path)).toContain(resolution.path);
  await applier.applyResolution([resolution]);
  await applier.publishResolved();

  // Read the resolved dependent head off the bare origin — the resolution landed on feat-dep.
  const originFiles = git(originPath, ["ls-tree", "-r", "--name-only", "feat-dep"])
    .trim()
    .split("\n")
    .filter((f) => f !== "");
  return { assembledHeadSha: integration.headSha, originFiles };
}

describe("WS-A PR-6b — base-shift conflict resolve over the LOCAL ancestor stack (real jj)", () => {
  it("a CONFLICTED dependent resolves against the LOCALLY-assembled stack head (no tanren/integ clone)", async () => {
    const { originPath } = makeConflictingStackFixture();
    const { assembledHeadSha, originFiles } = await resolveOverAssembledStack(originPath, ["feat-a", "feat-b"], {
      path: "shared.txt",
      content: "reconciled\n",
    });

    // The conflict was gathered + resolved against the LOCAL assembled head (a real sha), NOT a
    // synthesized `tanren/integ` host ref — and the resolution LANDED on the dependent's branch.
    expect(assembledHeadSha).toMatch(/^[0-9a-f]{40}$/u);
    const onOrigin = git(originPath, ["show", "feat-dep:shared.txt"]).trim();
    expect(onOrigin).toBe("reconciled");
    // NEVER-DISCARD + SITS-ON-THE-STACK: the dependent's resolved head carries BOTH ancestors'
    // contributions (it was rebased onto `main + a + b`), proving the resolve happened against the
    // assembled stack — `b.txt` (the non-conflicting ancestor) is present alongside the resolution.
    expect(originFiles).toEqual(expect.arrayContaining(["base.txt", "shared.txt", "b.txt"]));
  });

  it("a DROPPED (merged) ancestor is absent from the assembled resolve base", async () => {
    const { originPath } = makeConflictingStackFixture();
    // The re-resolved stack drops `feat-b` (its ancestor merged): the dependent resolves against
    // `main + a` only — `b.txt` MUST NOT reach the resolved dependent head.
    const { originFiles } = await resolveOverAssembledStack(originPath, ["feat-a"], {
      path: "shared.txt",
      content: "reconciled-small\n",
    });
    expect(originFiles).toEqual(expect.arrayContaining(["base.txt", "shared.txt"]));
    expect(originFiles).not.toContain("b.txt");
  });
});
