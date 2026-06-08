// The `MERGE_AUTHORITY_LIVE` kill-switch (tanren-owns-the-engine.md §5, §8) — the
// Wave-2 / S1 DIRECT CUTOVER flag. The native merge path's SOLE authoritative land
// decision is now `MergeAuthority` (prepareIntegration → authorizeLand → land); the
// scattered gate/governance/review/mergeability/budget/demo/HITL deciders this slice
// replaced are DELETED, not kept as a parallel path.
//
// DEFAULT ON (the operator chose direct cutover): with the flag unset OR set to
// anything other than the explicit OFF token, the authority is authoritative. The
// flag survives ONLY as a kill-switch — set `MERGE_AUTHORITY_LIVE=0` to revert the
// land call to the (now-removed-from-the-decision) host merge, which is retained
// purely as the break-glass mechanic. There is NO middle "shadow" mode: the
// authority either decides (default) or is fully bypassed (kill-switch) — never two
// gate authorities running side by side (§8 guardrail).

/**
 * Whether the live merge path routes its land through `MergeAuthority` (the default).
 * Fail-SAFE default: any value other than the explicit OFF token (`"0"`) leaves the
 * authority authoritative, so a typo'd flag can never silently disable the guaranteed
 * core — only the exact kill-switch token does.
 */
export function mergeAuthorityLive(): boolean {
  return process.env["MERGE_AUTHORITY_LIVE"] !== "0";
}
