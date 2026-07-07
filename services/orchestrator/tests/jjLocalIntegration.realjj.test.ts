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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { AncestorNotReadyError, integrateOverWorkspace } from "../src/engine/dag/jjLocalIntegration.js";
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
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

/**
 * The never-discard mid-flight-merge RACE fixture (tanren-owns-the-engine.md §3): `main` plus
 * the dependent's still-live ancestor `feat-b`, PLUS an ancestor `feat-a` that ALREADY MERGED
 * — its commit was fast-forwarded INTO `main` and its head branch DELETED (exactly what the
 * forge does when a PR merges). The dependent (the build spec) was in-flight assembling
 * against `feat-a@origin` when it vanished. `mergedHeadSha` is `feat-a`'s pristine head sha
 * (now contained in `main`) — the `ancestor_stack[].headSha` the assembly proves the merge
 * from. `goneUnmergedHeadSha` is a real sha NOT in `main` (a genuinely-missing branch).
 */
function makeMergedAncestorFixture(): { originPath: string; mergedHeadSha: string; goneUnmergedHeadSha: string } {
  const root = mkdtempSync(join(tmpdir(), "tanren-jj-local-merged-"));
  const work = join(root, "seed");
  const originPath = join(root, "origin.git");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "--quiet", "--initial-branch=main"]);
  assertGitDirUnder(work, root, gitEnv());
  writeFileSync(join(work, "base.txt"), "base\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);

  // The ancestor `feat-a` (the scaffold) — commit it, capture its head, then MERGE it into
  // `main` (fast-forward) and DELETE the branch: the merged-and-deleted state.
  git(work, ["checkout", "--quiet", "-b", "feat-a"]);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "feat a"]);
  const mergedHeadSha = revParse(work, "feat-a");

  // A genuinely-UNMERGED, soon-to-be-gone branch: commit it, capture its head, then delete it
  // WITHOUT merging — its commit is NOT contained in `main` (a real missing-ref fault).
  git(work, ["checkout", "--quiet", "main"]);
  git(work, ["checkout", "--quiet", "-b", "feat-gone"]);
  writeFileSync(join(work, "gone.txt"), "gone\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "feat gone"]);
  const goneUnmergedHeadSha = revParse(work, "feat-gone");

  // The still-live dependent ancestor `feat-b`.
  git(work, ["checkout", "--quiet", "main"]);
  git(work, ["checkout", "--quiet", "-b", "feat-b"]);
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "feat b"]);

  // MERGE feat-a into main (fast-forward — its commit now lives in `main`) and DELETE both the
  // merged branch AND the unmerged one, so neither `feat-a@origin` nor `feat-gone@origin`
  // exists on the clone (the mid-flight vanish).
  git(work, ["checkout", "--quiet", "main"]);
  git(work, ["merge", "--quiet", "--ff-only", "feat-a"]);
  git(work, ["branch", "--quiet", "-D", "feat-a"]);
  git(work, ["branch", "--quiet", "-D", "feat-gone"]);

  git(work, ["clone", "--quiet", "--bare", work, originPath]);
  return { originPath, mergedHeadSha, goneUnmergedHeadSha };
}

function revParse(cwd: string, ref: string): string {
  return git(cwd, ["rev-parse", ref]).trim();
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

  it("MATERIALIZES the integrated tree on disk — the working copy carries member files absent from the base (the no-PR-ever-merged regression)", async () => {
    // THE root cause this fixes: after the rebase loop assembles `localRef`, the working copy
    // at `workspacePath` still sat on the BASE (`openWorkspace` ends with `jj new <base>`;
    // `jj rebase`/`jj bookmark set` move commits/bookmarks but NEVER `@`). The batch re-gate
    // ran `pre_merge` against that base tree — a greenfield scaffold has no justfile on the
    // base, so the gate failed with `no justfile found` and the batch was bisected/dequeued.
    // Every batch check gated the wrong tree, so NO PR ever merged. The fix checks out the
    // integrated head (`jj edit <localRef>`) before returning. This proves it END-TO-END over
    // REAL jj: the on-disk working copy after the integration carries BOTH members' files
    // (`a.txt` + `b.txt`), neither of which exists on the base. WITHOUT the checkout the
    // working copy is still the base tree (only `base.txt`) and these assertions FAIL.
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

    expect(result.outcome).toBe("integrated");
    if (result.outcome !== "integrated") return;

    // The on-disk working copy at `workspacePath` reflects the INTEGRATED head, NOT the base.
    // Both members' files are present (each member adds a distinct file off the base) —
    // exactly what the `pre_merge` gate must see when it runs against this workspace.
    expect(existsSync(join(live.workspacePath, "a.txt"))).toBe(true);
    expect(existsSync(join(live.workspacePath, "b.txt"))).toBe(true);
    expect(readFileSync(join(live.workspacePath, "a.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(live.workspacePath, "b.txt"), "utf8")).toBe("b\n");
    // The base file is of course still present (the integration is base + members).
    expect(existsSync(join(live.workspacePath, "base.txt"))).toBe(true);
  });

  it("DROPS a merged-and-deleted ancestor (its branch vanished mid-flight) and assembles against the new base — never strands", async () => {
    // THE RACE this fixes (tanren-owns-the-engine.md §3): the dependent's `build` run was
    // in-flight assembling against `feat-a@origin` when the scaffold's PR MERGED and the merge
    // DELETED `feat-a`. WITHOUT the fix the `feat-a@origin` read throws
    // (`WorkspaceCommandError: jj read bookmark sha failed`) → the run fails `internal` → in the
    // unified model the dependent would RE-DRIVE (never the old terminal strand) but burn the
    // re-drive budget needlessly, and everything downstream stays `open`. WITH the fix: `feat-a`'s commit is PROVEN in the base
    // (its `knownHeadSha` is contained in `main`), so it is DROPPED, and the still-live `feat-b`
    // assembles against the new base — the dependent proceeds.
    const { originPath, mergedHeadSha } = makeMergedAncestorFixture();
    const live = liveLocalJj();
    const ssh = new LocalCommandSubstrate();

    const result = await integrateOverWorkspace(live, ssh, {
      baseBranch: "main",
      repoUrl: originPath,
      members: [
        // The merged-and-deleted ancestor — its branch is GONE, but its commit is in `main`.
        { specId: "spec-scaffold", branch: "feat-a", knownHeadSha: mergedHeadSha },
        // The still-live ancestor.
        { specId: "spec-other", branch: "feat-b" },
      ],
      localRef: "tanren-batch-merged-race",
      timeoutMs: 60_000,
    });

    // The assembly SUCCEEDS (no strand): the merged ancestor was dropped, `feat-b` stacked on
    // the new base (which now contains feat-a's content via the merge).
    expect(result.outcome).toBe("integrated");
    if (result.outcome !== "integrated") return;
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/u);
    // The dropped ancestor contributes NO member-head key (it is no longer a stack member).
    expect(result.memberHeadShas["spec-scaffold"]).toBeUndefined();
    // The surviving member's pristine head key is present.
    expect(result.memberHeadShas["spec-other"]).toMatch(/^[0-9a-f]{40}$/u);
    // The integrated working copy carries BOTH the merged ancestor's file (now in the base via
    // the merge) AND the live member's file — the dependent's base is the new merged base + the
    // remaining stack, exactly what never-discard re-drive requires.
    expect(existsSync(join(live.workspacePath, "a.txt"))).toBe(true);
    expect(existsSync(join(live.workspacePath, "b.txt"))).toBe(true);
  });

  it("FAILS LOUD for a genuinely-missing ancestor branch (deleted but NOT merged) — no silent masking", async () => {
    // FAIL-CLOSED counterpart: `feat-gone`'s branch is also gone, but its commit is NOT in
    // `main` (it never merged). A truly missing ancestor must stay a LOUD failure — the benign
    // drop is ONLY for a PROVEN merge (commit-in-base), never every missing branch. With NO
    // `ancestorPhase` (the fail-closed default) it stays the loud `Error`, not a benign wait.
    const { originPath, goneUnmergedHeadSha } = makeMergedAncestorFixture();
    const live = liveLocalJj();
    const ssh = new LocalCommandSubstrate();

    await expect(
      integrateOverWorkspace(live, ssh, {
        baseBranch: "main",
        repoUrl: originPath,
        members: [{ specId: "spec-gone", branch: "feat-gone", knownHeadSha: goneUnmergedHeadSha }],
        localRef: "tanren-batch-gone",
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/did NOT merge into main/u);
  });

  it("BENIGN-WAITS for a NON-TERMINAL headless ancestor (branch not published yet) — AncestorNotReadyError, NOT a strand", async () => {
    // THE BUG this fixes (tanren-owns-the-engine.md §3 never-discard, apex v35): the dependent
    // was driven speculatively but its ancestor `deploy` was still `in_flight` — its gate
    // looping, NO PR/branch published yet. The branch is GONE (never existed on origin) AND it
    // did NOT merge — but its SPEC is non-terminal (it WILL publish a head). WITHOUT the fix
    // this is the SAME loud `Error` as a phantom branch → the run fails `internal` → the
    // dependent TERMINALLY strands. WITH the fix: because the member carries a non-terminal
    // `ancestorPhase`, the assembly raises the BENIGN `AncestorNotReadyError` (a typed wait the
    // finalizer routes to a re-drive, never `needs_attention`). `feat-gone`'s commit is NOT in
    // `main`, so the merged-drop path does NOT apply — the phase is what makes it benign.
    const { originPath } = makeMergedAncestorFixture();
    const live = liveLocalJj();
    const ssh = new LocalCommandSubstrate();

    await expect(
      integrateOverWorkspace(live, ssh, {
        baseBranch: "main",
        repoUrl: originPath,
        // No `knownHeadSha` (the ancestor never published a head), but its spec is `in_flight`.
        members: [{ specId: "spec-deploy", branch: "feat-gone", ancestorPhase: "in_flight" }],
        localRef: "tanren-batch-not-ready",
        timeoutMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(AncestorNotReadyError);
  });

  it("FAILS LOUD (no benign wait) for a TERMINAL headless ancestor — it will NEVER publish a head", async () => {
    // CASE-3 FAIL-CLOSED: the ancestor branch is gone, did NOT merge, AND its spec is
    // `terminal_blocked` (halted/cancelled/needs_attention) — it will NEVER publish a head.
    // This is NOT a benign wait (there is nothing to wait for): it stays the LOUD `Error`, NOT
    // an `AncestorNotReadyError`. Only a PROVABLY non-terminal phase is benign.
    const { originPath, goneUnmergedHeadSha } = makeMergedAncestorFixture();
    const live = liveLocalJj();
    const ssh = new LocalCommandSubstrate();

    await expect(
      integrateOverWorkspace(live, ssh, {
        baseBranch: "main",
        repoUrl: originPath,
        members: [
          {
            specId: "spec-dead",
            branch: "feat-gone",
            knownHeadSha: goneUnmergedHeadSha,
            ancestorPhase: "terminal_blocked",
          },
        ],
        localRef: "tanren-batch-dead",
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/did NOT merge into main/u);
  });
});
