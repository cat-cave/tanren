// JJ-LOCAL INTEGRATION (tanren-owns-the-engine.md §3 — the one unified run model, §7 —
// "the server-side integration-branch build + 409 handling" is deleted), Wave-3 /
// Slice-3b. The SOLE integration assembler: a LOCAL integration over A1's
// `buildLiveJjWorkspace`, replacing the deleted server-side host-ref build (the
// `tanren/integ`/`tanren/batch` ref assembled via the 409-prone GitHub `/merges` API):
//
//   1. Open ONE live jj workspace on the base branch (jj's `git clone --colocate`
//      fetches the base + every member bookmark as `<branch>@origin`).
//   2. Stack the ordered members onto the base LOCALLY via jj's native rebase — a member
//      that conflicts with an earlier member is recorded IN the commit (jj first-class
//      conflicts: the rebase SUCCEEDS and records, it never aborts), which we surface as
//      the SAME spec-vs-spec `conflict` the server build returned.
//   3. Export the CLEAN local ref + materialize the node's `headSha`/`treeHash`. The
//      export REFUSES a still-conflicted ref (the §2 fail-closed boundary).
//
// NO `tanren/integ` / `tanren/batch` ref is written to the HOST — the integration is a
// runner-local jj bookmark; only the materialized identity (headSha/treeHash) flows
// back. This closes `mergeAuthorityImpl.ts:90`'s "Wave 2 carries headSha forward":
// `prepareIntegration` now materializes the head VIA the node.
//
// FAIL-CLOSED: the live workspace is ALWAYS released (LOUD on a leak); a member that
// cannot be resolved/rebased is a LOUD throw (never integrate a phantom); a conflicted
// export THROWS (never a conflicted ref to the host).

import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { WorkspaceHandle } from "../contracts/workspaceVcsCore.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand } from "../workspace/ssh.js";
import { buildLiveJjWorkspace, type LiveJjWorkspaceDeps, type LiveJjWorkspace } from "../providers/liveJjWorkspace.js";

/** One ordered member to integrate: its remote bookmark name (the PR head branch). */
export interface JjIntegrationMember {
  specId: string;
  branch: string;
  /**
   * The member's last-known PR-head sha (`ancestor_stack[].headSha`, captured at a prior
   * assembly). Load-bearing ONLY for the merged-and-deleted-mid-flight race
   * (`tanren-owns-the-engine.md §3 never-discard`): when a member's `<branch>@origin` is
   * GONE — the PR merged and the merge deleted its head branch WHILE this dependent was
   * in-flight assembling against it — this sha lets us PROVE the member MERGED (its commit
   * is now contained in the base branch) and DROP it (its content is in the base, mirroring
   * the coordinator's "ancestors that merged are dropped"), rather than crash on the vanished
   * ref and TERMINALLY strand the dependent. A missing/empty sha (or a sha NOT contained in
   * the base) keeps the missing-branch a LOUD failure — only a PROVEN merge is benign.
   */
  knownHeadSha?: string;
}

/** The facts the jj-local integration clones + stacks against. */
export interface JjLocalIntegrationInput {
  baseBranch: string;
  /** The repo URL the workspace clones (the SAME the deps' facts carry). */
  repoUrl: string;
  /** The ordered members (DAG order — ancestors before dependents) to stack on the base. */
  members: ReadonlyArray<JjIntegrationMember>;
  /** A stable, safe local bookmark name for the integrated head (NEVER pushed to the host). */
  localRef: string;
  timeoutMs: number;
}

/**
 * The result of a jj-local integration. On `integrated`: the materialized `headSha` +
 * `treeHash` of the locally-stacked node, the per-member head SHAs captured at
 * integration time (the divergence key), and the (LOCAL) ref name. On `conflict`: the
 * spec-vs-spec pair jj recorded (the member that conflicted with an earlier-stacked one).
 */
export type JjLocalIntegrationResult =
  | {
      outcome: "integrated";
      localRef: string;
      headSha: string;
      treeHash: string;
      memberHeadShas: Record<string, string>;
      /**
       * The OPEN workspace handle the integration assembled `localRef` in (present
       * when `integrateOverWorkspace` ran the real assembly). The BOOTSTRAP consumer
       * (`bootstrapDependentBase`) reads it to create the dependent's run branch AT
       * the integrated head on the SAME open workspace; the batch consumer (which
       * gates on `LiveJjWorkspace`, not the handle) ignores it. Optional so a fake
       * integration result (the batch unit tests) need not synthesize a handle.
       */
      workspace?: WorkspaceHandle;
    }
  | {
      outcome: "conflict";
      conflictBetween: { specId: string; otherSpecId: string };
      message: string;
    };

/**
 * Run a jj-local integration over a freshly provisioned live jj workspace, releasing it
 * (LOUD on a leak) on EVERY path. The workspace deps (allocator/ssh/secrets/vcsProvider/
 * facts) are A1's — the SAME thread the live conflict resolver + base-shift use. `ssh` is
 * threaded separately so the few non-contract jj probes (remote-bookmark sha, tree hash,
 * bookmark fast-forward) shell over the SAME substrate the core uses.
 *
 * The CONTINUATION (`onIntegrated`) runs WHILE the workspace is still open — the
 * integrated head is a LOCAL jj bookmark (never a host ref), so the gate MUST run on
 * THIS workspace (the §3b point: no `tanren/batch` host ref to clone elsewhere). It is
 * handed the live workspace + the integrated result. On a `conflict` outcome the
 * continuation is NOT called (there is nothing to gate); the conflict result flows back.
 */
export async function withJjLocalIntegration<T>(
  workspaceDeps: LiveJjWorkspaceDeps,
  input: JjLocalIntegrationInput,
  onIntegrated: (
    live: LiveJjWorkspace,
    integrated: Extract<JjLocalIntegrationResult, { outcome: "integrated" }>,
  ) => Promise<T>,
): Promise<{ outcome: "integrated"; value: T } | Extract<JjLocalIntegrationResult, { outcome: "conflict" }>> {
  const live = await buildLiveJjWorkspace(workspaceDeps);
  try {
    const integration = await integrateOverWorkspace(live, workspaceDeps.ssh, input);
    if (integration.outcome === "conflict") {
      return integration;
    }
    return { outcome: "integrated", value: await onIntegrated(live, integration) };
  } finally {
    await live.release();
  }
}

/**
 * Stack the ordered members onto the base in the open workspace. The workspace's clone
 * already fetched every bookmark; we build a fresh local integration bookmark on the
 * base, then rebase each member's segment onto the accumulated head IN ORDER. jj records
 * a conflict IN the commit (the rebase never aborts), so after each member the rebase
 * result tells us whether the head carries a conflict: a recorded conflict ⇒ the
 * spec-vs-spec `conflict` the coordinator routes to the resolver. A clean stack ⇒ export
 * the clean ref + read headSha/treeHash.
 */
export async function integrateOverWorkspace(
  live: LiveJjWorkspace,
  ssh: CommandSubstrate,
  input: JjLocalIntegrationInput,
): Promise<JjLocalIntegrationResult> {
  const { core, workspacePath, target } = live;
  const ws = await core.openWorkspace({ repoUrl: input.repoUrl, baseBranch: input.baseBranch, path: workspacePath });
  // NEVER-DISCARD RACE (tanren-owns-the-engine.md §3): a member's `<branch>@origin` may have
  // VANISHED between enqueue and now — its PR merged and the merge deleted the head branch
  // WHILE this dependent was in-flight assembling against it. Resolve the LIVE member set
  // BEFORE tracking/stacking: a member whose branch is gone but whose commit is PROVABLY in
  // the base (it merged) is DROPPED (its content is already in `baseBranch`, mirroring the
  // coordinator's "ancestors that merged are dropped"); a branch gone for ANY OTHER reason is
  // still a LOUD throw (no silent masking of a real missing ref). The surviving members keep
  // the caller's DAG order.
  const members = await resolveLiveMembers(
    ssh,
    target,
    workspacePath,
    input.baseBranch,
    input.members,
    input.timeoutMs,
  );
  // §3.5 PREP (SAME as the jj applier's gather() / the base-shift rebase): `jj git clone`
  // imports each member's NON-default branch only as a REMOTE-tracking bookmark
  // (`<branch>@origin`), which jj treats as IMMUTABLE — rebasing it refuses with "would
  // rewrite immutable commits". So track each member's remote bookmark as a LOCAL `<branch>`
  // bookmark (the mutable name we rebase + read back), and empty the immutable set for THIS
  // short-lived workspace. Without this every member rebase refuses → the whole batch wedges.
  await prepareMemberBookmarks(ssh, target, workspacePath, members, input.timeoutMs);
  // Create the local integration bookmark at the base head (NEVER a host ref). After this,
  // the accumulated integration head is tracked purely from each rebase result — no
  // intermediate host writes, no re-reads.
  await core.branch(ws, input.localRef, input.baseBranch);
  let accumulatedHead = await readBookmarkSha(ssh, target, workspacePath, input.localRef, input.timeoutMs);

  const memberHeadShas: Record<string, string> = {};
  const merged: string[] = [];
  for (const member of members) {
    // The member's remote bookmark head AT integration time (the divergence key) — read
    // from the REMOTE-tracking ref, which a LOCAL rebase below never advances (it stays the
    // pristine pre-integration head).
    memberHeadShas[member.specId] = await readBookmarkSha(
      ssh,
      target,
      workspacePath,
      `${member.branch}@origin`,
      input.timeoutMs,
    );
    // Rebase the member's segment (the tracked LOCAL bookmark, NOT the immutable remote one)
    // onto the accumulated integration head. jj first-class conflicts: a conflicting rebase
    // SUCCEEDS + records the conflict IN the commit. `rebaseOnto` reads the post-rebase head
    // from the LOCAL `<branch>` bookmark — which the local rewrite DID advance (the
    // remote-tracking `<branch>@origin` would NOT, yielding the un-rebased head, §3.5).
    const rebase = await core.rebaseOnto(ws, member.branch, accumulatedHead);
    accumulatedHead = rebase.headSha;
    // Fast-forward the integration bookmark to the rebased member head (the new top).
    await setBookmark(ssh, target, workspacePath, input.localRef, accumulatedHead, input.timeoutMs);
    if (rebase.outcome === "conflicted") {
      // The other side is the prior stacked member (or the base) — the spec-vs-spec
      // conflict the coordinator routes to the resolver (early, on the integration, not
      // against the innocent dependent). Mirrors the server build's `conflictBetween`.
      const otherSpecId = merged.at(-1) ?? input.baseBranch;
      return {
        outcome: "conflict",
        conflictBetween: { specId: member.specId, otherSpecId },
        message: `member ${member.specId} (${member.branch}) conflicts with the integration of ${otherSpecId} on ${input.localRef} (jj-local)`,
      };
    }
    merged.push(member.specId);
  }

  // Materialize the integrated tree ON DISK before returning. `jj rebase` + `jj bookmark
  // set` only move COMMITS/BOOKMARKS — they NEVER move `@` (the working copy), which
  // `openWorkspace` left on the BASE branch (`jj new <baseBranch>`). Without this, the
  // continuation runs against `workspacePath`'s BASE tree (no member files), not the
  // integrated head — the no-PR-ever-merged root cause: the batch re-gate runs `pre_merge`
  // on the base working copy, so a greenfield scaffold failed with `no justfile found`
  // (the scaffold's files live ONLY on the integrated bookmark, never on the base working
  // copy), got bisected/blamed, and dequeued as a `conflict`. `checkout` (`jj edit
  // <localRef>`) checks out that commit's tree on the colocated workspace, so the on-disk
  // working copy at `workspacePath` now reflects the integrated files. Done ONLY on the
  // CLEAN path (a conflicted member short-circuited above — there is nothing clean to
  // materialize, and `exportCleanGitRef` would refuse it anyway).
  //
  // SAFE for the BOOTSTRAP consumer (`bootstrapDependentBase`): it then runs `core.branch(
  // ws, runBranch, localRef)`, which creates the run branch with `localRef` as the EXPLICIT
  // parent (`jj new localRef`), independent of where `@` sits — and leaves `@` on a fresh
  // child of `localRef` (still the integrated tree). Moving `@` to `localRef` first does
  // not disturb it.
  await core.checkout(ws, input.localRef);
  // Export the CLEAN local ref (REFUSES a still-conflicted ref — the §2 boundary) +
  // materialize the node's head + tree. The export wrote the git ref into the colocated
  // .git, so the tree is read from git off the exported head sha.
  const exported = await core.exportCleanGitRef(ws, input.localRef);
  const treeHash = await readTreeHash(ssh, target, workspacePath, exported.headSha, input.timeoutMs);
  // Surface the open `ws` handle so the bootstrap consumer can create the dependent's
  // run branch at the integrated head ON THIS workspace (the batch consumer ignores it).
  return {
    outcome: "integrated",
    localRef: input.localRef,
    headSha: exported.headSha,
    treeHash,
    memberHeadShas,
    workspace: ws,
  };
}

/**
 * §3.5 prep: track each member's REMOTE bookmark as a LOCAL bookmark (the mutable name the
 * member rebase names + reads back), and empty the immutable set so a published head can be
 * rewritten in THIS short-lived workspace. Mirrors `jjWorkspaceApplier.gather()` +
 * `baseShiftLiveRebase` verbatim. FAIL-CLOSED: a track/config failure throws (no `|| true`).
 */
async function prepareMemberBookmarks(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspacePath: string,
  members: ReadonlyArray<JjIntegrationMember>,
  timeoutMs: number,
): Promise<void> {
  // jj 0.42 `bookmark track` takes the bare bookmark NAME (not `<name>@origin`) plus
  // `--remote`; it imports `<name>@origin` as the LOCAL `<name>` bookmark.
  const trackCommands = members.map((m) => `jj bookmark track ${quoteSshShellArg(m.branch)} --remote origin`);
  await runWorkspaceSshCommand(ssh, target, {
    label: "jj-local integration: track member bookmarks + allow rewriting them",
    cwd: workspacePath,
    timeoutMs,
    command: [
      "set -eu",
      ...trackCommands,
      `jj config set --repo ${quoteSshShellArg('revset-aliases."immutable_heads()"')} ${quoteSshShellArg("none()")}`,
    ].join(" && "),
  });
}

/**
 * NEVER-DISCARD RACE (tanren-owns-the-engine.md §3): resolve which members are STILL live
 * before the assembly tracks/stacks them. A member's `<branch>@origin` may have VANISHED
 * because its PR merged + the merge deleted the head branch WHILE this dependent was
 * in-flight assembling — the read of the gone ref would otherwise crash the run and
 * TERMINALLY strand the dependent.
 *
 * For each ordered member:
 *   - the `<branch>@origin` ref RESOLVES ⇒ a live member (kept, in order);
 *   - the ref is GONE but the member MERGED — PROVEN by its `knownHeadSha`
 *     (`ancestor_stack[].headSha`) being a non-empty 40-hex sha CONTAINED in `<baseBranch>
 *     @origin` ⇒ DROP it (its content is in the base, mirroring the coordinator's "ancestors
 *     that merged are dropped"); continue with a smaller, still-correct stack;
 *   - the ref is GONE for ANY OTHER reason (no known head sha, or a head sha NOT contained in
 *     the base) ⇒ a LOUD throw (a genuine missing ref is never silently masked).
 *
 * FAIL-CLOSED: only a PROVEN merge (commit-in-base) is benign; an absence we cannot explain
 * stays a hard failure.
 */
async function resolveLiveMembers(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspacePath: string,
  baseBranch: string,
  members: ReadonlyArray<JjIntegrationMember>,
  timeoutMs: number,
): Promise<JjIntegrationMember[]> {
  const live: JjIntegrationMember[] = [];
  for (const member of members) {
    if (await revisionExists(ssh, target, workspacePath, `${member.branch}@origin`, timeoutMs)) {
      live.push(member);
      continue;
    }
    // The member's branch is GONE. Only a PROVEN merge (its commit now in the base) is a
    // benign drop — anything else is a real missing-ref fault we must NOT mask.
    const knownHeadSha = member.knownHeadSha;
    const merged =
      knownHeadSha !== undefined &&
      /^[0-9a-f]{40}$/u.test(knownHeadSha) &&
      (await commitContainedInBase(ssh, target, workspacePath, knownHeadSha, baseBranch, timeoutMs));
    if (merged) {
      // Its content is already in `baseBranch` — drop it (never-discard: nothing is lost).
      continue;
    }
    throw new Error(
      `jj-local integration: member ${member.specId} (${member.branch}) has no ${member.branch}@origin ref ` +
        `and did NOT merge into ${baseBranch} (knownHeadSha=${knownHeadSha ?? "<none>"}) — refusing to silently ` +
        `drop a genuinely missing ancestor branch`,
    );
  }
  return live;
}

/** True iff `rev` RESOLVES in the workspace (a non-throwing presence probe — no LOUD failure). */
async function revisionExists(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspacePath: string,
  rev: string,
  timeoutMs: number,
): Promise<boolean> {
  // `jj log -r <rev>` exits non-zero when the revision does not resolve; probe the exit code
  // directly (NOT `runWorkspaceSshCommand`, which throws) so a legitimately-absent ref is a
  // clean `false`, not an error. The substrate boundary is the same the rest of this file uses.
  // `ssh.run` (NOT `runWorkspaceSshCommand`) returns the result IN-BAND (no throw), so a
  // legitimately-absent ref reads as a clean non-zero exit rather than an error.
  const result = await ssh.run(target, {
    cwd: workspacePath,
    timeoutMs,
    command: `jj log -r ${quoteSshShellArg(rev)} --no-graph -T 'commit_id'`,
  });
  // A clean exit with a 40-hex sha ⇒ present. A non-zero exit (or a substrate failure/timeout,
  // which a real connectivity fault would raise) ⇒ absent — the caller then PROVES merge-or-not
  // via the base-containment check, so a connectivity blip cannot masquerade as a benign drop
  // (it has no merged commit in the base, so it stays a loud failure).
  if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
    return false;
  }
  return /^[0-9a-f]{40}$/u.test(result.stdout.trim());
}

/**
 * True iff `headSha` is CONTAINED in `<baseBranch>@origin` (the member's commit landed in the
 * base — i.e. the PR merged). The workspace is `--colocate`d (jj wrote a real `.git`), so
 * `git merge-base --is-ancestor <headSha> <baseBranch>@origin's sha` is the stable containment
 * read: exit 0 ⇒ ancestor (merged), exit 1 ⇒ not (genuinely missing). A non-existent `headSha`
 * (`git` cannot resolve it) is NOT-contained ⇒ the caller keeps it a LOUD failure.
 */
async function commitContainedInBase(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspacePath: string,
  headSha: string,
  baseBranch: string,
  timeoutMs: number,
): Promise<boolean> {
  // Resolve the base branch's current remote sha (the merge lands here); jj imported it as
  // the `<baseBranch>@origin` remote-tracking bookmark. If even the base is gone the assembly
  // can't proceed — let the caller's downstream base read raise the real error.
  const baseSha = (
    await ssh.run(target, {
      cwd: workspacePath,
      timeoutMs,
      command: `jj log -r ${quoteSshShellArg(`${baseBranch}@origin`)} --no-graph -T 'commit_id'`,
    })
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(baseSha)) {
    return false;
  }
  const result = await ssh.run(target, {
    cwd: workspacePath,
    timeoutMs,
    command: `git merge-base --is-ancestor ${quoteSshShellArg(headSha)} ${quoteSshShellArg(baseSha)}`,
  });
  // `--is-ancestor` exits 0 when `headSha` is an ancestor of `baseSha` (contained ⇒ merged), 1
  // when not, and >1 / a substrate failure on a bad arg (e.g. an unknown `headSha`). Only a
  // clean exit-0 is a proven merge; everything else stays NOT-contained (a loud failure).
  return result.failure === undefined && !result.timedOut && result.exitCode === 0;
}

/** Read a bookmark's commit sha via jj's `commit_id` template (the value `jj git export` writes). */
async function readBookmarkSha(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspacePath: string,
  rev: string,
  timeoutMs: number,
): Promise<string> {
  const out = await runWorkspaceSshCommand(ssh, target, {
    label: "jj read bookmark sha",
    cwd: workspacePath,
    timeoutMs,
    command: `jj log -r ${quoteSshShellArg(rev)} --no-graph -T 'commit_id'`,
  });
  const sha = out.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`jj-local integration: revision ${rev} did not resolve a head sha`);
  }
  return sha;
}

/** Point a local bookmark at `sha` (fast-forward the integration top after a rebase). */
async function setBookmark(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspacePath: string,
  bookmark: string,
  sha: string,
  timeoutMs: number,
): Promise<void> {
  await runWorkspaceSshCommand(ssh, target, {
    label: "jj set integration bookmark",
    cwd: workspacePath,
    timeoutMs,
    command: [
      "set -eu",
      `jj bookmark set ${quoteSshShellArg(bookmark)} -r ${quoteSshShellArg(sha)} --allow-backwards`,
    ].join(" && "),
  });
}

/**
 * Read the integrated head's git tree hash (the materialized node's `treeHash`) off the
 * exported head sha. jj 0.42 has NO `tree_id` template keyword on a Commit, and the
 * workspace is `--colocate`d (the export wrote a real git ref), so `git rev-parse
 * <sha>^{tree}` is the stable read. The tree hash is the content identity proof reuse keys on.
 */
async function readTreeHash(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspacePath: string,
  headSha: string,
  timeoutMs: number,
): Promise<string> {
  const out = await runWorkspaceSshCommand(ssh, target, {
    label: "jj-local integration: read tree hash",
    cwd: workspacePath,
    timeoutMs,
    command: `git rev-parse ${quoteSshShellArg(`${headSha}^{tree}`)}`,
  });
  const treeId = out.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(treeId)) {
    throw new Error(`jj-local integration: ${headSha} did not resolve a git tree hash`);
  }
  return treeId;
}
