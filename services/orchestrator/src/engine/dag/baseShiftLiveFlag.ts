// The `BASE_SHIFT_LIVE` kill-switch (tanren-owns-the-engine.md §3 never-discard, §5) — the
// Wave-3 / Slice-2 DIRECT CUTOVER flag, mirroring `conflictResolverJjLive` (the merge
// authority's own flag was already collapsed — its land is now unconditional). The
// base-shift handler's workspace/re-gate/resolver seams are now
// LIVE: a base shift (an ancestor lands under an in-flight dependent, OR the merge-path
// `behind` mergeability) actually REBASES the dependent's existing branch onto the shifted
// base over a live allocated runner (A1's `buildLiveJjWorkspace`), re-gates it with the
// fresh-runner native gate, and resolves a recorded conflict with the answerer-backed jj
// resolver — never-discard, in place. The fail-closed `Held*` stubs it replaced are
// retained ONLY as the break-glass kill-switch path — not a parallel default.
//
// DEFAULT ON (the operator chose direct cutover): with the flag unset OR set to anything
// other than the explicit OFF token, the live seams drive the base shift on BOTH paths
// (the change-percolation kick-off + the merge-path `behind` handler). The live
// jj-against-a-runner path is FIRST exercised by the apex run (its merge-queue base
// shifts are the validation vehicle); the runnable jj behavior below it is already
// conformance-pinned. Set `BASE_SHIFT_LIVE=0` to revert to the `Held*` loud-hold stubs —
// a CLEAN kill-switch (no half-state: either the live seams own the whole
// rebase→re-gate→resolve flow, or the held stubs hold the work loudly), never two
// base-shift mechanisms running side by side.

/**
 * Whether the base-shift handler's workspace/re-gate/resolver seams are LIVE (the
 * default). Fail-SAFE default: any value other than the explicit OFF token (`"0"`)
 * leaves the live seams authoritative, so a typo'd flag can never silently fall back to
 * the held stubs — only the exact kill-switch token does. (The held stubs themselves are
 * fail-closed, so even the kill-switch never silently discards or merges.)
 */
export function baseShiftLive(): boolean {
  return process.env["BASE_SHIFT_LIVE"] !== "0";
}
