// The jj shell steps that make a PUBLISHED remote head branch a resolvable LOCAL bookmark
// for an in-place rebase — ROBUST against the "head not in the initial clone" race and
// FAIL-CLOSED on a genuinely-missing head. Shared by every base-shift / conflict-resolve
// call site that rebases a dependent's OWN published head (`baseShiftLiveRebase`,
// `baseShiftStackAssembly`, `jjWorkspaceApplier.gather`), so the guard is identical.
//
// THE BUG THIS CLOSES (apex v94 `speculative_assembly` halt): the prep used a bare
//   `jj bookmark track <head> --remote origin`
// and nothing else. `jj bookmark track` matches <head> as a GLOB PATTERN, so when the
// remote-tracking bookmark `<head>@origin` is ABSENT from the workspace — the base-shift
// clone predated the dependent's head push, or the head simply wasn't fetched — the track
// matches ZERO bookmarks, prints nothing, and EXITS 0. A SILENT NO-OP: no local `<head>`
// bookmark is created, so the subsequent `jj rebase -b <head>` fails
//   Error: Revision `<head>` doesn't exist
// which the coordinator re-drives forever until the convergence cap fires
// `run.failed {failureCode: speculative_assembly}` — even though the head branch EXISTS on
// the forge (GitHub returns 200 for its ref). The CLI form is CORRECT; the defect is the
// silent no-op when the remote bookmark is not present in THIS workspace.
//
// THE GUARD (three steps, all under the caller's `set -eu`):
//   1. `jj git fetch --branch <head>` — import `<head>@origin` if it appeared on the forge
//      AFTER the clone (repairs the race). A no-match is a WARNING + exit 0, so the fetch
//      alone is NOT the fail-closed gate — it only repairs a genuinely-present-but-unfetched
//      head.
//   2. `jj bookmark track <head> --remote origin` — bind the (now-present) remote bookmark
//      to the LOCAL `<head>` bookmark the rebase names.
//   3. `jj log -r <head>` ASSERT — jj exits 1 when the local bookmark STILL does not resolve
//      (a genuinely-missing head: never on the forge, or a phantom ref). Under `set -eu`
//      that aborts the whole command LOUDLY, so the coordinator HOLDS (fail-closed,
//      re-driven) instead of silently leaving the rebase target missing. This is the point
//      of the fix: a track that tracked nothing must FAIL, never silently continue.

import { quoteSshShellArg } from "../ssh/command.js";

/**
 * The `&&`-joinable jj steps that make `headBranch` a resolvable LOCAL bookmark, robustly and
 * fail-closed (see the module header). Callers splice these into their own `set -eu` command
 * chain (keeping their own label / watchdog / immutable-heads config), e.g.
 *   command: ["set -eu", ...trackPublishedHeadCommands(head), `jj config set ... none()`].join(" && ")
 */
export function trackPublishedHeadCommands(headBranch: string): string[] {
  const name = quoteSshShellArg(headBranch);
  return [
    // 1. Repair the race: import `<head>@origin` if it landed after the clone (no-match is a
    //    warning + exit 0, so this is NOT the gate — step 3 is).
    `jj git fetch --branch ${name} --remote origin`,
    // 2. Bind the remote-tracking bookmark to the LOCAL `<head>` the rebase names.
    `jj bookmark track ${name} --remote origin`,
    // 3. FAIL-CLOSED ASSERT: `jj log -r <head>` exits 1 if the local bookmark still doesn't
    //    resolve (the track glob matched nothing) — aborting the `set -eu` chain LOUDLY
    //    rather than leaving the rebase `-b <head>` target silently missing.
    `jj log -r ${name} --no-graph -T 'commit_id' >/dev/null`,
  ];
}
