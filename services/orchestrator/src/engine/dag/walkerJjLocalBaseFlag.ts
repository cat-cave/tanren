// The `WALKER_JJ_LOCAL_BASE` flag (walker-jj-local-integration-design.md §2.1, §7 PR-4).
//
// Gates whether a DEPENDENT speculative run materializes its base by jj-ASSEMBLING the
// real ancestor PR-head refs LOCALLY on its own runner (`bootstrapDependentBase`, the
// §2.1 bootstrap variant) — REPLACING the legacy single-ref `git clone --branch
// <speculative_base>` of an orchestrator-synthesized `tanren/integ/<dep>` host ref.
//
// DEFAULT OFF — the OPPOSITE polarity of the engine's KILL-SWITCHES
// (`CONFLICT_RESOLVER_JJ_LIVE` et al, which default ON via `!== "0"`). This is a
// BUILD-FORWARD flag, not a kill-switch: the jj-local base path is ADDITIVE and unproven
// until apex exercises it, so it is reachable ONLY when an operator EXPLICITLY enables it
// (`WALKER_JJ_LOCAL_BASE=1`). With the flag unset (production), the run takes the EXACT
// single-ref clone it takes today — flag-off is byte-identical to main.
//
// LIFECYCLE: this PR (PR-4) makes the path REACHABLE but default-off. PR-7 flips the
// default ON (after the realjj + walker/percolation/base-shift suites + an apex-tier live
// exercise prove it). PR-9 (WS-B) removes the flag once the jj-local path is the only path.

/**
 * Whether the dependent run's base is assembled jj-locally (the §2.1 bootstrap variant).
 * DEFAULT OFF: true ONLY when `WALKER_JJ_LOCAL_BASE` is the explicit ON token (`"1"`), so
 * a typo'd / unset flag keeps the proven single-ref clone — the new path is opt-in until
 * PR-7 flips it. (Contrast the kill-switches, which default ON and only `"0"` reverts.)
 */
export function walkerJjLocalBase(): boolean {
  return process.env["WALKER_JJ_LOCAL_BASE"] === "1";
}
