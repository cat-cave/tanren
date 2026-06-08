// The `CONFLICT_RESOLVER_JJ_LIVE` kill-switch (tanren-owns-the-engine.md §2, §5) — the
// Wave-3 / S1 DIRECT CUTOVER flag mirroring `mergeAuthorityLive`. The live conflict
// resolver's workspace mechanism is now jj's FIRST-CLASS conflicts (the
// `JjWorkspaceConflictApplier` over A1's `buildLiveJjWorkspace`): `rebaseOnto` RECORDS
// the conflict (no `git merge --abort` dance, no `|| true` fail-open), `resolveConflict`
// writes the intent-preserving answer into the commit, `exportCleanGitRef` REFUSES a
// still-conflicted ref. The git-merge-abort `SshWorkspaceConflictApplier` it replaced is
// retained ONLY as the break-glass kill-switch path — not a parallel default.
//
// DEFAULT ON (the operator chose direct cutover): with the flag unset OR set to anything
// other than the explicit OFF token, the live jj applier is the workspace mechanism on
// BOTH conflict paths (the in-loop `direct_merge` resolver + the drive-pass resolver).
// The live jj-against-a-runner path is FIRST exercised by the apex run (its merge-queue
// conflicts are the validation vehicle); the runnable jj behavior below it is already
// conformance-pinned (the real-jj WorkspaceVcsCore conformance + this slice's applier
// behavior tests). Set `CONFLICT_RESOLVER_JJ_LIVE=0` to revert to the git-merge-abort
// applier — a CLEAN kill-switch (no half-state: either the jj applier owns the whole
// gather→apply→publish/abort flow, or the legacy applier does), never two mechanisms
// running side by side.

/**
 * Whether the live conflict resolver's workspace mechanism is the jj applier (the
 * default). Fail-SAFE default: any value other than the explicit OFF token (`"0"`)
 * leaves the jj applier authoritative, so a typo'd flag can never silently fall back to
 * the git-merge-abort path — only the exact kill-switch token does.
 */
export function conflictResolverJjLive(): boolean {
  return process.env["CONFLICT_RESOLVER_JJ_LIVE"] !== "0";
}
