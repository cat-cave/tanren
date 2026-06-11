// The `WALKER_JJ_LOCAL_BASE` flag (walker-jj-local-integration-design.md §2.1, §7 PR-7).
//
// Gates whether a DEPENDENT speculative run materializes its base by jj-ASSEMBLING the
// real ancestor PR-head refs LOCALLY on its own runner (`bootstrapDependentBase`, the
// §2.1 bootstrap variant) — REPLACING the legacy single-ref `git clone --branch
// <speculative_base>` of an orchestrator-synthesized `tanren/integ/<dep>` host ref.
//
// DEFAULT ON — the SAME polarity as the engine's KILL-SWITCHES (`CONFLICT_RESOLVER_JJ_LIVE`
// et al, which default ON via `!== "0"`). PR-7 flipped this default: the jj-local base path
// is now the LIVE default, having been proven by the realjj + walker/percolation/base-shift
// suites and validated by an apex-tier live exercise. `WALKER_JJ_LOCAL_BASE=0` is the
// BREAK-GLASS to the old synthesized-`tanren/integ`-ref path, which STAYS present (now dead
// in production but reachable as the kill-switch) until WS-B/PR-9 deletes it.
//
// LIFECYCLE: PR-4 made the path REACHABLE but default-off. PR-7 (this) flips the default ON
// (the jj-local base is the live path; `=0` reverts to the legacy single-ref clone). PR-9
// (WS-B) removes the flag once the synthesized-ref path is deleted and jj-local is the only
// path.

/**
 * Whether the dependent run's base is assembled jj-locally (the §2.1 bootstrap variant).
 * DEFAULT ON: true UNLESS `WALKER_JJ_LOCAL_BASE` is the explicit OFF token (`"0"`), the
 * break-glass to the legacy single-ref clone. (Same polarity as the engine kill-switches,
 * which default ON and only `"0"` reverts — PR-7 flipped this from the PR-4 default-off.)
 */
export function walkerJjLocalBase(): boolean {
  return process.env["WALKER_JJ_LOCAL_BASE"] !== "0";
}
