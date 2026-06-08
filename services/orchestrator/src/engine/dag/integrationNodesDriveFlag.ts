// The `INTEGRATION_NODES_DRIVE` kill-switch (tanren-owns-the-engine.md §3 — proof reuse
// + the one unified run model) — the Wave-3 / Slice-3 DIRECT CUTOVER flag, mirroring
// `baseShiftLive` / `conflictResolverJjLive` / `mergeAuthorityLive`. With the flag ON
// (default), `integration_nodes` DRIVE control flow on the gate/CI verdict path:
//
//   (3a) PROOF REUSE — before running the gate, the verdict site computes the
//        `proofReuseKey` from the LIVE inputs (the node's memberKey + the current
//        gateConfigHash + policyVersion + runnerImage + appEnvHash + quarantineVersion)
//        and looks up a recorded proof. A HIT with a PASSING recorded verdict SKIPS the
//        re-gate (`integration.proof.reused`); a MISS — or a non-passing recorded
//        verdict, or ANY unresolvable key component — RECOMPUTES (run the gate +
//        `recordProof`). The safety invariant: a proof is reused ONLY when ALL SIX key
//        components match EXACTLY — never a stale reuse that merges unproven code.
//
//   (3b) JJ-LOCAL INTEGRATION — the prospective merged state is assembled LOCALLY over
//        A1's `buildLiveJjWorkspace` (jj's native rebase/restack) and the clean ref is
//        exported, instead of the server-side `VcsProvider.buildIntegrationBranch`
//        (the 409-prone `tanren/integ/<dep>` host ref). NO `tanren/integ` ref is
//        written to the host.
//
// DEFAULT ON (the operator chose direct cutover): with the flag unset OR set to anything
// other than the explicit OFF token (`"0"`), `integration_nodes` drive the verdict path.
// Set `INTEGRATION_NODES_DRIVE=0` to revert to the ALWAYS-RECOMPUTE behavior (no proof
// reuse) + the server-side integrator — a CLEAN kill-switch, never a half-state.
//
// FAIL-SAFE in BOTH directions: the OFF token reverts to always-recompute (which can
// never reuse a stale proof — it always re-gates); the ON path's reuse is itself
// fail-closed (any key uncertainty recomputes). So neither the flag default NOR a typo'd
// value can ever let unproven code merge.

/**
 * Whether `integration_nodes` DRIVE the gate/CI verdict path (proof reuse + jj-local
 * integration) — the default. Fail-SAFE default: any value other than the explicit OFF
 * token (`"0"`) leaves the integration-node drive authoritative, so a typo'd flag can
 * never silently fall back to the always-recompute path — only the exact kill-switch
 * token does. (Both paths are fail-closed against a stale reuse, so neither can merge
 * unproven code.)
 */
export function integrationNodesDrive(): boolean {
  return process.env["INTEGRATION_NODES_DRIVE"] !== "0";
}
