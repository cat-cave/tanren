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
//
// AUTHENTICATED FETCH (apex v95/v96 `merge.conflict`-stall regression): step 1's
// `jj git fetch --remote origin` hits the workspace's `origin` remote, which on a live run is
// the HTTPS remote the AUTHENTICATED `jj git clone` cloned from (`https://github.com/...`).
// On a PRIVATE repo an UNAUTHENTICATED fetch fails
//   fatal: could not read Username for 'https://github.com': No such device or address
// which under `set -eu` aborts the whole base-shift prep → the coordinator maps the throw to
// `merge.conflict` → dequeue → the PR is stuck forever → the run STALLS on every dependent
// PR that goes "behind". So when a clone credential is present the fetch MUST authenticate the
// SAME way the clone does — the `gitTokenAuthPrelude` askpass helper (token from STDIN into a
// 0700 temp file, NEVER on argv / in any logged command / any emitted event) + the auth env +
// `--config git.subprocess=true` so the git-CLI fetch consults `GIT_ASKPASS` regardless of any
// jj default. ANONYMOUS (no credential) stays a bare fetch — a genuinely public repo / the
// conformance fixture's local-path origin needs no auth (don't break the public path).

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { runWorkspaceSshCommand } from "../workspace/ssh.js";
import { gitTokenAuthPrelude } from "../workspace/githubPush.js";

/**
 * The credential the authenticated published-head `jj git fetch` uses. The SAME token the
 * workspace was `jj git clone`d with (the workspace's `origin` is the HTTPS remote that token
 * authenticates), threaded through so the post-clone fetch authenticates identically. Minimal
 * by design (only the token is needed — the origin remote URL is already configured); a
 * `JjCloneCredential` is structurally assignable.
 */
export interface PublishedHeadFetchCredential {
  /** The resolved installation/static token (the `x-access-token` HTTPS password). */
  token: string;
}

/**
 * The published-head track PREP: the `&&`-joinable steps callers splice into their own
 * `set -eu` chain, plus (authenticated path only) the token fed to the askpass helper via
 * stdin. The stdin token travels ONLY through the command's stdin — never the command string
 * the workspace-command error logs (see `runWorkspaceSshCommand`), the process args, or any
 * emitted event.
 */
export interface TrackPublishedHeadPrep {
  /** The `&&`-joinable jj steps (prelude + fetch + track + assert). */
  commands: string[];
  /** Present only on the authenticated path — the token fed to the askpass helper via stdin. */
  stdin?: string;
}

/**
 * Build the jj steps that make `headBranch` a resolvable LOCAL bookmark, robustly and
 * fail-closed (see the module header). Callers splice `prep.commands` into their own `set -eu`
 * command chain (keeping their own label / watchdog / immutable-heads config) and forward
 * `prep.stdin` to `runWorkspaceSshCommand`, e.g.
 *   const prep = trackPublishedHeadCommands(head, live.cloneCredential);
 *   command: ["set -eu", ...prep.commands, `jj config set ... none()`].join(" && ")
 *   ...(prep.stdin !== undefined && { stdin: prep.stdin })
 *
 * AUTHENTICATED when a `credential` is present (the private-repo path — mirrors
 * `buildJjCloneCommand`), ANONYMOUS when not (a genuinely public repo / the conformance
 * fixture's local-path origin).
 */
/**
 * Read the sha jj FETCHED for the published head — the commit `<headBranch>@origin`
 * (the remote-tracking bookmark) resolves to AFTER `trackPublishedHeadCommands` fetched it.
 * This is the PRE-REBASE remote head: the local in-place rebase rewrites the LOCAL
 * `<headBranch>` bookmark but NEVER `<headBranch>@origin`, so this stays the exact sha the
 * forge branch pointed at when we cloned/fetched — the expected-old-sha the dependent-head
 * publish leases against (`--force-with-lease`, #1059). A concurrent reviewer/writer commit
 * that advanced the forge head DURING the rebase + answerer + re-gate window makes the lease
 * stale, so the publish REJECTS rather than silently overwriting their work.
 *
 * FAIL-CLOSED: a non-40-hex read throws (never lease against a bogus value — that would push
 * with `--force-with-lease=<ref>:` and degrade to an effectively-blind force).
 */
export async function readFetchedPublishedHeadSha(input: {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  headBranch: string;
}): Promise<string> {
  const rev = `${input.headBranch}@origin`;
  const out = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "published head: read fetched remote head sha (force-with-lease guard)",
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
    command: `jj log -r ${quoteSshShellArg(rev)} --no-graph -T 'commit_id'`,
  });
  const sha = out.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(
      `published head ${input.headBranch}: fetched remote head (${rev}) did not resolve a commit sha ` +
        `(force-with-lease guard) — got '${sha}'`,
    );
  }
  return sha;
}

export function trackPublishedHeadCommands(
  headBranch: string,
  credential?: PublishedHeadFetchCredential,
): TrackPublishedHeadPrep {
  const name = quoteSshShellArg(headBranch);
  // 2. Bind the remote-tracking bookmark to the LOCAL `<head>` the rebase names.
  const track = `jj bookmark track ${name} --remote origin`;
  // 3. FAIL-CLOSED ASSERT: `jj log -r <head>` exits 1 if the local bookmark still doesn't
  //    resolve (the track glob matched nothing) — aborting the `set -eu` chain LOUDLY rather
  //    than leaving the rebase `-b <head>` target silently missing.
  const assert = `jj log -r ${name} --no-graph -T 'commit_id' >/dev/null`;
  if (credential === undefined) {
    return {
      commands: [
        // 1. Repair the race: import `<head>@origin` if it landed after the clone (no-match is
        //    a warning + exit 0, so this is NOT the gate — the assert is). ANONYMOUS: the
        //    origin remote needs no credential (public repo / local-path fixture).
        `jj git fetch --branch ${name} --remote origin`,
        track,
        assert,
      ],
    };
  }
  return {
    commands: [
      // 1. Repair the race — AUTHENTICATED. The askpass prelude reads the token from STDIN
      //    into a 0700 temp file (NEVER on argv), and the auth env + `git.subprocess=true`
      //    make the git-CLI fetch consult `GIT_ASKPASS` against the HTTPS `origin` remote —
      //    exactly as `buildJjCloneCommand` authenticates the clone fetch.
      ...gitTokenAuthPrelude(),
      `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$askpass" GITHUB_TOKEN_FILE="$token_file" ` +
        `jj git fetch --branch ${name} --remote origin --config git.subprocess=true`,
      track,
      assert,
    ],
    stdin: credential.token,
  };
}
